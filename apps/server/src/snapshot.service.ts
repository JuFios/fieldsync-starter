import { HttpStatus, Injectable } from '@nestjs/common';
import { asVersion, type EntityName, type Row, type SnapshotKey, type SnapshotPage } from '@fieldsync/sync-core';
import { accessibleSites } from './access';
import type { AuthUser } from './auth';
import { Db, type TxSql } from './db';
import { isTransient, retryLater } from './db-errors';
import { resetRequired } from './log-floor';
import { ProblemException } from './problem';

interface EntityRow {
  entity: EntityName;
  id: string;
  site_id: string;
  data: Row;
}

/** What a snapshot page asks for, as the controller validated it. */
export interface SnapshotQuery {
  watermark?: number;
  after?: SnapshotKey;
  limit: number;
}

/**
 * Snapshots of the live state for clients that start, or restart after a reset: pages of live rows
 * of the user's sites in key order `(site_id, entity, id)`, then the change log from the snapshot's
 * watermark.
 *
 * Why that converges whatever is written meanwhile: each page shows its rows as they are when it is
 * read, not as of the watermark W. A row that did not change after W reads the same in every page.
 * Every change after W is in the log after W, in commit order and without gaps (see finishMutation),
 * so the pull from W ends each changed row at its last change: one created behind the page cursor,
 * deleted before its page, moved to another site or edited after its page are all put right by the
 * log. The client replaces its state only once it has pulled the log (`SyncClient`), so an older
 * value replayed from the log over a newer one read in a page never shows. The log after W is kept
 * while W is at or above the floor; a snapshot whose watermark fell below it is answered 410 and
 * starts again.
 */
@Injectable()
export class SnapshotService {
  constructor(private readonly db: Db) {}

  /**
   * One page, read in one read-only REPEATABLE READ transaction with the head and floor of the log.
   * The page carries that head: every row of it holds no change after it, so once the client has
   * pulled the log up to the highest head of its pages, the rows and the log form one state of the
   * server (see `SnapshotPage.head`). Throws 410 RESET_REQUIRED for a watermark below the floor and 400 for one above the head.
   */
  page(user: AuthUser, query: SnapshotQuery): Promise<SnapshotPage> {
    return this.db
      .tx((c) => this.read(c, user, query), { isolation: 'REPEATABLE READ', readOnly: true })
      .catch((err: unknown) => {
        throw isTransient(err) ? retryLater() : err;
      });
  }

  private async read(c: TxSql, user: AuthUser, query: SnapshotQuery): Promise<SnapshotPage> {
    const ends = await c.query<{ head: string; floor: string }>(
      `SELECT h.version AS head, f.version AS floor FROM log_head h, log_floor f WHERE h.id = 1 AND f.id = 1`,
    );
    const head = Number(ends.rows[0].head);
    const floor = Number(ends.rows[0].floor);
    const watermark = query.watermark ?? head;
    if (watermark > head) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The watermark is ahead of the change log', {
        head,
      });
    }
    if (watermark < floor) throw resetRequired(floor);

    const sites = await accessibleSites(c, user);
    // One row more than the page tells whether another page follows.
    const { rows } =
      query.after === undefined
        ? await c.query<EntityRow>(
            `SELECT entity, id, site_id, data FROM entities
              WHERE NOT deleted AND site_id = ANY($1::uuid[])
              ORDER BY site_id, entity, id
              LIMIT $2`,
            [sites, query.limit + 1],
          )
        : await c.query<EntityRow>(
            `SELECT entity, id, site_id, data FROM entities
              WHERE NOT deleted AND site_id = ANY($1::uuid[]) AND (site_id, entity, id) > ($2::uuid, $3::text, $4::uuid)
              ORDER BY site_id, entity, id
              LIMIT $5`,
            [sites, query.after.siteId, query.after.entity, query.after.id, query.limit + 1],
          );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      watermark: asVersion(watermark),
      head: asVersion(head),
      rows: page.map((r) => ({ entity: r.entity, id: r.id, siteId: r.site_id, data: r.data })),
      next: rows.length > query.limit && last ? { siteId: last.site_id, entity: last.entity, id: last.id } : null,
    };
  }
}
