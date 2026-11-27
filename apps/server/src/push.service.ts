import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  asLastMutationId,
  asVersion,
  MutationRejected,
  type ClientId,
  type LastMutationId,
  type MutationId,
  type MutationResult,
  type PushResponse,
  type ReceivedMutation,
  type Rejection,
} from '@fieldsync/sync-core';
import type { AuthUser } from './auth';
import { Clock } from './clock';
import { Db, type TxSql } from './db';
import { isTransient, retryLater } from './db-errors';
import { ProblemException } from './problem';
import { applyMutation, finishMutation, type LogEntry } from './server-tx';
import { StreamService } from './stream.service';

interface Outcome {
  result: MutationResult;
  /** Sites whose data the mutation changed, to notify after the commit. */
  touched: string[];
}

interface StoredResult {
  status: 'applied' | 'rejected';
  code: Rejection['code'] | null;
  message: string | null;
  details: Rejection['details'] | null;
  version: string | null;
}

/** The result the client receives for a mutation the mutator refused. */
function rejected(id: MutationId, rejection: Rejection): MutationResult {
  return {
    id,
    status: 'rejected',
    code: rejection.code,
    message: rejection.message,
    ...(rejection.details === undefined ? {} : { details: rejection.details }),
  };
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly db: Db,
    private readonly streams: StreamService,
    private readonly clock: Clock,
  ) {}

  /**
   * Applies the client's mutations in order, each in its own transaction, and answers each one.
   * Effectively once: a mutation is applied at most once however many copies of it arrive, at once
   * or later, and every copy is answered with the original outcome (see {@link applyOne}).
   */
  async push(user: AuthUser, req: { clientId: ClientId; mutations: ReceivedMutation[] }): Promise<PushResponse> {
    const results: MutationResult[] = [];
    for (const m of req.mutations) {
      // A transient failure is a 503: this mutation was not applied, the ones before it were, and
      // the client's retry gets those answered as duplicates.
      const { result, touched } = await this.db
        .tx((c) => this.applyOne(c, user, req.clientId, m))
        .catch((err: unknown) => {
          throw isTransient(err) ? retryLater() : err;
        });
      if (touched.length > 0) this.streams.notify(touched);
      results.push(result);
    }
    return { results, lastMutationId: await this.lastMutationId(req.clientId) };
  }

  /**
   * Retires a client id of this user: from now on no new mutation is applied under it (copies of
   * handled ones are still answered). Idempotent; an id nobody used yet is recorded as retired, so it
   * can never be used. Takes the client's row lock like a push, so a push in progress finishes first.
   * Returns the last mutation id the server handled under it, which no later request can change.
   * An id another user owns is answered 404, as if it did not exist.
   */
  async retire(user: AuthUser, clientId: ClientId): Promise<{ lastMutationId: LastMutationId }> {
    const { rows } = await this.db
      .query<{ last_mutation_id: string }>(
        `INSERT INTO clients (client_id, user_id, last_mutation_id, retired_at) VALUES ($1, $2, 0, $3)
         ON CONFLICT (client_id) DO UPDATE SET retired_at = coalesce(clients.retired_at, EXCLUDED.retired_at)
          WHERE clients.user_id = EXCLUDED.user_id
         RETURNING last_mutation_id`,
        [clientId, user.id, this.clock.now()],
      )
      .catch((err: unknown) => {
        throw isTransient(err) ? retryLater() : err;
      });
    if (rows.length === 0) throw new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No such client');
    return { lastMutationId: asLastMutationId(Number(rows[0].last_mutation_id)) };
  }

  async lastMutationId(clientId: ClientId): Promise<LastMutationId> {
    const { rows } = await this.db.query<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM clients WHERE client_id = $1`,
      [clientId],
    );
    return rows.length ? asLastMutationId(Number(rows[0].last_mutation_id)) : 0;
  }

  /**
   * One mutation in the caller's transaction. The client's row is locked first, so copies of a
   * mutation (and different mutations of one client) run one after another: the copy that gets the
   * lock second sees the last applied id the first one committed. The mutator then runs in a
   * savepoint, taken after the lock so that rolling back to it keeps the lock (PostgreSQL 13.3.2).
   * Locks are always taken in this order: client row, entity rows by key, `log_head` last.
   */
  private async applyOne(c: TxSql, user: AuthUser, clientId: ClientId, m: ReceivedMutation): Promise<Outcome> {
    const { last, ownerId, retired } = await this.lockClient(c, clientId, user.id);
    if (m.id <= last) {
      // Only the client's owner learns how its mutations ended (their rejections carry stored data).
      // That another user can push under this client id at all is a known defect (F-33).
      const result: MutationResult =
        ownerId === user.id ? await this.previousResult(c, clientId, m.id) : { id: m.id, status: 'duplicate' };
      return { result, touched: [] };
    }
    if (retired) {
      // Its owner continues under another id: nothing new is applied under this one, so a late copy
      // of an old request cannot apply a mutation the client has since sent again under the new id.
      throw new ProblemException(HttpStatus.GONE, 'CLIENT_RETIRED', `Client ${clientId} was retired`, {
        lastMutationId: last,
      });
    }
    if (m.id !== last + 1) {
      // A gap: the mutations between were never received. The client cannot fill it (it would have
      // to renumber mutations a delayed copy of an older request may still carry), so it is told.
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'MUTATION_OUT_OF_ORDER',
        `Mutation ${m.id} does not follow the last applied one; expected ${last + 1}`,
        { expected: last + 1 },
      );
    }
    const at = this.clock.now();
    let result: MutationResult;
    let entries: LogEntry[] = [];
    try {
      entries = await c.savepoint(() => applyMutation(c, user, m, at));
      result = { id: m.id, status: 'applied' };
    } catch (err) {
      if (err instanceof MutationRejected) {
        // The rejection is recorded like an application: the mutation is final and the next follows.
        // Checked first: its message may hold text the client sent, which must not make it transient.
        result = rejected(m.id, err);
      } else if (isTransient(err)) {
        throw err;
      } else {
        // The same mutation would fail the same way on every retry (a defect of the mutator or of the
        // data, not of the moment): it is rejected, so the queue behind it moves on.
        this.logger.error(
          `Mutation ${m.id} (${m.name}) of client ${clientId} failed`,
          err instanceof Error ? err.stack : String(err),
        );
        result = rejected(m.id, { code: 'INTERNAL', message: 'The server could not apply this mutation' });
      }
    }
    // Last: one statement records the outcome and appends the changes; the change log's ordering
    // lock is held from here to the commit only.
    const version = await finishMutation(c, {
      clientId,
      mutationId: m.id,
      status: result.status === 'rejected' ? 'rejected' : 'applied',
      code: result.status === 'rejected' ? result.code : null,
      message: result.status === 'rejected' ? result.message : null,
      details: result.status === 'rejected' ? result.details : undefined,
      entries,
      at,
    });
    if (result.status === 'applied' && version !== undefined) result = { ...result, version: asVersion(version) };
    return { result, touched: [...new Set(entries.map((e) => e.siteId))] };
  }

  /**
   * Locks the client's row, creating it on its first push; returns its last applied id, its owner and
   * whether it was retired.
   */
  private async lockClient(
    c: TxSql,
    clientId: ClientId,
    userId: string,
  ): Promise<{ last: LastMutationId; ownerId: string; retired: boolean }> {
    await c.query(
      `INSERT INTO clients (client_id, user_id, last_mutation_id) VALUES ($1, $2, 0)
       ON CONFLICT (client_id) DO NOTHING`,
      [clientId, userId],
    );
    const { rows } = await c.query<{ last_mutation_id: string; user_id: string; retired: boolean }>(
      `SELECT last_mutation_id, user_id, retired_at IS NOT NULL AS retired FROM clients WHERE client_id = $1 FOR UPDATE`,
      [clientId],
    );
    const last = asLastMutationId(Number(rows[0].last_mutation_id));
    return { last, ownerId: rows[0].user_id, retired: rows[0].retired };
  }

  /**
   * The answer for a copy of a mutation that was already handled: its rejection, or "duplicate" if
   * it was applied. Results older than the change-log retention are gone; such a copy is answered as
   * a duplicate (its client has to reload its state anyway).
   */
  private async previousResult(c: TxSql, clientId: ClientId, id: MutationId): Promise<MutationResult> {
    const { rows } = await c.query<StoredResult>(
      `SELECT status, code, message, details, version FROM mutation_results WHERE client_id = $1 AND mutation_id = $2`,
      [clientId, id],
    );
    const stored = rows[0];
    if (stored?.status === 'rejected' && stored.code !== null && stored.message !== null) {
      return rejected(id, { code: stored.code, message: stored.message, details: stored.details ?? undefined });
    }
    const version = stored?.version;
    return version === null || version === undefined
      ? { id, status: 'duplicate' }
      : { id, status: 'duplicate', version: asVersion(Number(version)) };
  }
}
