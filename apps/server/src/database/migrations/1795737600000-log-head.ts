import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Change-log versions in commit order. A version used to come from the `change_log` sequence when
 * the row was inserted, so a transaction that took version 5 and committed after the one that took
 * 6 was invisible to a reader that had already moved its cursor past 6: the change was never
 * delivered. Now every writing transaction takes its versions from the one `log_head` row as its
 * last step, holding the row lock until it commits: versions are assigned, and become visible, in
 * commit order and without gaps. The head starts at the last version the sequence handed out.
 */
export class LogHead1795737600000 implements MigrationInterface {
  name = 'LogHead1795737600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE log_head (
        id smallint PRIMARY KEY CHECK (id = 1),
        version bigint NOT NULL CHECK (version >= 0)
      );
      -- Never below a version the sequence handed out: rows of rolled-back inserts, or the newest
      -- rows removed by the GC, may have taken them, and clients can hold any of them as a cursor.
      INSERT INTO log_head (id, version)
      SELECT 1, greatest(
        (SELECT coalesce(max(version), 0) FROM change_log),
        (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM change_log_version_seq)
      );
      ALTER TABLE change_log ALTER COLUMN version DROP DEFAULT;
      DROP SEQUENCE change_log_version_seq;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE SEQUENCE change_log_version_seq OWNED BY change_log.version;
      SELECT setval('change_log_version_seq', greatest(version, 1), version > 0) FROM log_head;
      ALTER TABLE change_log ALTER COLUMN version SET DEFAULT nextval('change_log_version_seq');
      DROP TABLE log_head;
    `);
  }
}
