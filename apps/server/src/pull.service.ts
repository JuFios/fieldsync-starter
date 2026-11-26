import { Injectable } from '@nestjs/common';
import type { Change, PullResponse } from '@fieldsync/sync-core';
import { accessibleSites } from './access';
import type { AuthUser } from './auth';
import { Db, type TxSql } from './db';

interface LogRow {
  version: string;
  site_id: string;
  entity: Change['entity'];
  entity_id: string;
  op: 'put' | 'del';
  data: Change['data'];
}

@Injectable()
export class PullService {
  constructor(private readonly db: Db) {}

  /**
   * Up to `limit` changes after `cursor`, read with everything else in one read-only REPEATABLE READ
   * transaction, so the page, the head of the log and the client's last mutation id come from one
   * snapshot. Versions become visible in commit order (see `finishMutation`), so the snapshot holds
   * every version up to its head and no later one. When the page is not full the cursor moves to that
   * head, past changes the user does not see, so a client with nothing new does not read the same
   * rows again; `hasMore` is true exactly when changes after the page exist in the snapshot.
   */
  pull(user: AuthUser, cursor: number, limit: number, clientId?: string): Promise<PullResponse> {
    return this.db.tx((c) => this.page(c, user, cursor, limit, clientId), {
      isolation: 'REPEATABLE READ',
      readOnly: true,
    });
  }

  private async page(
    c: TxSql,
    user: AuthUser,
    cursor: number,
    limit: number,
    clientId?: string,
  ): Promise<PullResponse> {
    const head = await c.query<{ version: string }>(`SELECT version FROM log_head WHERE id = 1`);
    const headVersion = Number(head.rows[0].version);
    const sites = await accessibleSites(c, user);
    // Other sites' changes in incremental pulls are a known defect of the access control (F-07).
    const siteFilter = cursor === 0 ? sites : null;

    // One row more than the page tells whether more changes follow.
    const { rows } = await c.query<LogRow>(
      `SELECT version, site_id, entity, entity_id, op, data
         FROM change_log
        WHERE version > $1 AND version <= $2 AND ($3::uuid[] IS NULL OR site_id = ANY($3))
        ORDER BY version
        LIMIT $4`,
      [cursor, headVersion, siteFilter, limit + 1],
    );
    const hasMore = rows.length > limit;
    const changes: Change[] = rows.slice(0, limit).map((r) => ({
      version: Number(r.version),
      entity: r.entity,
      id: r.entity_id,
      siteId: r.site_id,
      op: r.op,
      data: r.data,
    }));

    let lastMutationId = 0;
    if (clientId) {
      const res = await c.query<{ last_mutation_id: string }>(
        `SELECT last_mutation_id FROM clients WHERE client_id = $1`,
        [clientId],
      );
      lastMutationId = res.rows.length ? Number(res.rows[0].last_mutation_id) : 0;
    }

    return {
      changes,
      // Never backwards: a cursor beyond the head stays where it is (a reset log is a later change).
      nextCursor: hasMore ? changes[changes.length - 1].version : Math.max(cursor, headVersion),
      hasMore,
      lastMutationId,
    };
  }
}
