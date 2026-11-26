import { BadRequestException, Injectable } from '@nestjs/common';
import {
  MutationRejected,
  type MutationResult,
  type PushResponse,
  type ReceivedMutation,
  type Rejection,
} from '@fieldsync/sync-core';
import type { AuthUser } from './auth';
import { Clock } from './clock';
import { Db, type TxSql } from './db';
import { appendToLog, applyMutation, type LogEntry } from './server-tx';
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
}

/** The result the client receives for a mutation the mutator refused. */
function rejected(id: number, rejection: Rejection): MutationResult {
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
  async push(user: AuthUser, req: { clientId: string; mutations: ReceivedMutation[] }): Promise<PushResponse> {
    const results: MutationResult[] = [];
    for (const m of req.mutations) {
      const { result, touched } = await this.db.tx((c) => this.applyOne(c, user, req.clientId, m));
      if (touched.length > 0) this.streams.notify(touched);
      results.push(result);
    }
    return { results, lastMutationId: await this.lastMutationId(req.clientId) };
  }

  async lastMutationId(clientId: string): Promise<number> {
    const { rows } = await this.db.query<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM clients WHERE client_id = $1`,
      [clientId],
    );
    return rows.length ? Number(rows[0].last_mutation_id) : 0;
  }

  /**
   * One mutation in the caller's transaction. The client's row is locked first, so copies of a
   * mutation (and different mutations of one client) run one after another: the copy that gets the
   * lock second sees the last applied id the first one committed. The mutator then runs in a
   * savepoint, taken after the lock so that rolling back to it keeps the lock (PostgreSQL 13.3.2).
   * Locks are always taken in this order: client row, entity rows by key, `log_head` last.
   */
  private async applyOne(c: TxSql, user: AuthUser, clientId: string, m: ReceivedMutation): Promise<Outcome> {
    const last = await this.lockClient(c, clientId, user.id);
    if (m.id <= last) return { result: await this.previousResult(c, clientId, m.id), touched: [] };
    if (m.id !== last + 1) {
      throw new BadRequestException(`Out-of-order mutation ${m.id}, expected ${last + 1}`);
    }
    const at = this.clock.now();
    let result: MutationResult;
    let entries: LogEntry[] = [];
    try {
      entries = await c.savepoint(() => applyMutation(c, user, m, at));
      result = { id: m.id, status: 'applied' };
    } catch (err) {
      if (!(err instanceof MutationRejected)) throw err;
      // The rejection is recorded like an application: the mutation is final and the next follows.
      result = rejected(m.id, err);
    }
    await c.query(
      `INSERT INTO mutation_results (client_id, mutation_id, status, code, message, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        clientId,
        m.id,
        result.status,
        result.status === 'rejected' ? result.code : null,
        result.status === 'rejected' ? result.message : null,
        result.status === 'rejected' && result.details !== undefined ? JSON.stringify(result.details) : null,
        at,
      ],
    );
    await c.query(`UPDATE clients SET last_mutation_id = $2 WHERE client_id = $1`, [clientId, m.id]);
    // Last: the change log's ordering lock is held from here to the commit only.
    await appendToLog(c, entries, at);
    return { result, touched: [...new Set(entries.map((e) => e.siteId))] };
  }

  /** Locks the client's row, creating it on its first push, and returns its last applied id. */
  private async lockClient(c: TxSql, clientId: string, userId: string): Promise<number> {
    await c.query(
      `INSERT INTO clients (client_id, user_id, last_mutation_id) VALUES ($1, $2, 0)
       ON CONFLICT (client_id) DO NOTHING`,
      [clientId, userId],
    );
    const { rows } = await c.query<{ last_mutation_id: string }>(
      `SELECT last_mutation_id FROM clients WHERE client_id = $1 FOR UPDATE`,
      [clientId],
    );
    return Number(rows[0].last_mutation_id);
  }

  /**
   * The answer for a copy of a mutation that was already handled: its rejection, or "duplicate" if
   * it was applied. Results older than the change-log retention are gone; such a copy is answered as
   * a duplicate (its client has to reload its state anyway).
   */
  private async previousResult(c: TxSql, clientId: string, id: number): Promise<MutationResult> {
    const { rows } = await c.query<StoredResult>(
      `SELECT status, code, message, details FROM mutation_results WHERE client_id = $1 AND mutation_id = $2`,
      [clientId, id],
    );
    const stored = rows[0];
    if (stored?.status === 'rejected' && stored.code !== null && stored.message !== null) {
      return rejected(id, { code: stored.code, message: stored.message, details: stored.details ?? undefined });
    }
    return { id, status: 'duplicate' };
  }
}
