import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deletes the parts the original `ticket.delete` left behind (F-31): live parts whose ticket is
 * deleted or missing. Like any deletion, each is published in the change log, with versions from
 * the log head, so clients that hold the part drop it on their next pull.
 */
export class DeleteOrphanParts1795910400000 implements MigrationInterface {
  name = 'DeleteOrphanParts1795910400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      WITH orphans AS (
        SELECT p.id, p.site_id, row_number() OVER (ORDER BY p.id) AS n
          FROM entities p
         WHERE p.entity = 'part' AND NOT p.deleted
           AND NOT EXISTS (
             SELECT 1 FROM entities t
              WHERE t.entity = 'ticket' AND t.id::text = p.data->>'ticketId' AND NOT t.deleted
           )
      ),
      head AS (
        UPDATE log_head SET version = version + (SELECT count(*) FROM orphans)
         WHERE id = 1 AND EXISTS (SELECT 1 FROM orphans)
        RETURNING version
      ),
      logged AS (
        INSERT INTO change_log (version, site_id, entity, entity_id, op, data, created_at)
        SELECT head.version - (SELECT count(*) FROM orphans) + o.n, o.site_id, 'part', o.id, 'del', NULL, now()
          FROM orphans o, head
        RETURNING entity_id, version
      )
      UPDATE entities e SET deleted = true, data = NULL, version = logged.version
        FROM logged
       WHERE e.entity = 'part' AND e.id = logged.entity_id
    `);
  }

  async down(): Promise<void> {
    // The parts' data is gone, as for every deletion; there is nothing to restore.
  }
}
