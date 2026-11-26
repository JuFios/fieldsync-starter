import { BadRequestException, Injectable } from '@nestjs/common';
import { MutationRejected, type MutationResult, type PushResponse, type ReceivedMutation } from '@fieldsync/sync-core';
import type { AuthUser } from './auth';
import { Clock } from './clock';
import { Db } from './db';
import { applyMutation } from './server-tx';
import { StreamService } from './stream.service';

/** The result the client receives for a mutation the mutator refused. */
function rejected(id: number, err: MutationRejected): MutationResult {
  return {
    id,
    status: 'rejected',
    code: err.code,
    message: err.message,
    ...(err.details === undefined ? {} : { details: err.details }),
  };
}

@Injectable()
export class PushService {
  constructor(
    private readonly db: Db,
    private readonly streams: StreamService,
    private readonly clock: Clock,
  ) {}

  async push(user: AuthUser, req: { clientId: string; mutations: ReceivedMutation[] }): Promise<PushResponse> {
    const results: MutationResult[] = [];
    for (const m of req.mutations) {
      const last = await this.lastMutationId(req.clientId);
      if (m.id <= last) {
        results.push({ id: m.id, status: 'duplicate' });
        continue;
      }
      if (m.id !== last + 1) {
        throw new BadRequestException(`Out-of-order mutation ${m.id}, expected ${last + 1}`);
      }
      const { result, touched } = await this.db.tx(async (c) => {
        // The mutator runs in a savepoint: a rejection undoes its writes but keeps the transaction,
        // which records the rejection by advancing the client's last mutation id like an
        // application does, so the mutation is final and the ones after it can follow.
        let outcome: { result: MutationResult; touched: string[] };
        try {
          const sites = await c.savepoint(() => applyMutation(c, user, m, this.clock.now()));
          outcome = { result: { id: m.id, status: 'applied' }, touched: sites };
        } catch (err) {
          if (!(err instanceof MutationRejected)) throw err;
          outcome = { result: rejected(m.id, err), touched: [] };
        }
        await c.query(
          `INSERT INTO clients (client_id, user_id, last_mutation_id) VALUES ($1, $2, $3)
           ON CONFLICT (client_id) DO UPDATE SET last_mutation_id = $3`,
          [req.clientId, user.id, m.id],
        );
        return outcome;
      });
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
}
