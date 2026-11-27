import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The lower end of the change log. `log_floor.version` is the highest version the GC has removed:
 * every change up to it is gone, every later one is kept. A pull with a cursor below it is answered
 * 410 `RESET_REQUIRED` instead of silently skipping the removed changes (F-34), and the GC raises it
 * in the same transaction that removes a prefix of the log.
 *
 * It is a row of its own, not a column of `log_head`: every writer updates the head, and the GC
 * locking it would stop them all.
 *
 * On a database the original GC already pruned, the floor starts below the oldest kept version (or
 * at the head when nothing is kept), so clients with older cursors are reset rather than left with
 * gaps; holes the original GC left inside the kept part cannot be told apart from versions rolled
 * back under the old sequence. Tombstones and results of applied mutations whose changes are below
 * the floor are left to the GC, which removes them in batches like everything else.
 *
 * The GC deletes from `change_log` and `mutation_results` in bulk, so autovacuum visits them after a
 * twentieth of their rows are dead instead of the default fifth.
 */
export class LogFloor1796083200000 implements MigrationInterface {
  name = 'LogFloor1796083200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE log_floor (
        id smallint PRIMARY KEY CHECK (id = 1),
        version bigint NOT NULL CHECK (version >= 0)
      );
      INSERT INTO log_floor (id, version)
      SELECT 1, coalesce((SELECT min(version) - 1 FROM change_log), (SELECT version FROM log_head WHERE id = 1));
      ALTER TABLE change_log SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
      ALTER TABLE mutation_results SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE mutation_results RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);
      ALTER TABLE change_log RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);
      DROP TABLE log_floor;
    `);
  }
}
