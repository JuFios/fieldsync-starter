import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes of the log lifecycle, chosen with EXPLAIN (ANALYZE, BUFFERS) on a database of 1 million
 * log entries, 300 000 entities and 500 000 mutation results (README, Indexes):
 *
 * - `entities_snapshot_idx (site_id, entity, id) WHERE NOT deleted`: the key order of snapshot pages.
 *   Without it a page of a large site sorts every row of the site up to the page (a page in the
 *   middle of a 100 000-row site: 19 ms and 50 000 rows read, 2.6 ms with it), so a snapshot costs
 *   quadratic time in the size of the site.
 * - `entities_tombstone_idx (version) WHERE deleted`: the tombstones of a GC batch, which otherwise
 *   scans every entity per batch (36 ms against 4 ms per batch of 5000 versions).
 * - `mutation_results_applied_version_idx (version) WHERE status = 'applied'`: the results of the
 *   applied mutations of a GC batch (25 ms against 2 ms).
 *
 * `change_log_created_idx` is dropped: the GC now removes the log by version, through the primary
 * key, and no query filters the log by `created_at` any more; every insert paid for it.
 *
 * Built and dropped concurrently, outside a transaction, so writes go on meanwhile.
 */
export class LogLifecycleIndexes1796169600000 implements MigrationInterface {
  name = 'LogLifecycleIndexes1796169600000';
  transaction = false as const;

  async up(q: QueryRunner): Promise<void> {
    // A build interrupted earlier leaves an invalid index behind; start over in that case.
    for (const name of ['entities_snapshot_idx', 'entities_tombstone_idx', 'mutation_results_applied_version_idx']) {
      await q.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    }
    await q.query(
      `CREATE INDEX CONCURRENTLY entities_snapshot_idx ON entities (site_id, entity, id) WHERE NOT deleted`,
    );
    await q.query(`CREATE INDEX CONCURRENTLY entities_tombstone_idx ON entities (version) WHERE deleted`);
    await q.query(
      `CREATE INDEX CONCURRENTLY mutation_results_applied_version_idx ON mutation_results (version) WHERE status = 'applied'`,
    );
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS change_log_created_idx`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS change_log_created_idx`);
    await q.query(`CREATE INDEX CONCURRENTLY change_log_created_idx ON change_log (created_at)`);
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS mutation_results_applied_version_idx`);
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS entities_tombstone_idx`);
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS entities_snapshot_idx`);
  }
}
