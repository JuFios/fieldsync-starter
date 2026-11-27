import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tombstones are kept for good (a deleted id is never taken again), so no query looks them up by
 * version any more: `entities_tombstone_idx`, which served the GC's removal of tombstones, only costs
 * every deletion an index write. Dropped concurrently, outside a transaction, so writes go on.
 */
export class KeepTombstones1796256000000 implements MigrationInterface {
  name = 'KeepTombstones1796256000000';
  transaction = false as const;

  async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS entities_tombstone_idx`);
  }

  async down(q: QueryRunner): Promise<void> {
    // A build interrupted earlier leaves an invalid index behind; start over in that case.
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS entities_tombstone_idx`);
    await q.query(`CREATE INDEX CONCURRENTLY entities_tombstone_idx ON entities (version) WHERE deleted`);
  }
}
