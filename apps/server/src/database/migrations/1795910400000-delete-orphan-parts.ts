import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deletes the parts the original `ticket.delete` left behind (F-31): live parts whose ticket is
 * deleted or missing. Like any deletion, each is published in the change log, with versions from
 * the log head, so clients that hold the part drop it on their next pull.
 *
 * First, the ids inside tickets and parts (`id`, `siteId`, `ticketId`) are stored in lower case,
 * as ids are everywhere else: the original server kept them as the client sent them, the cascade
 * finds a ticket's parts by comparing the ticket id as text (a part with an upper-case one would
 * outlive its ticket, and be taken for an orphan here), and mutations made from such a row would
 * now be rejected. The changes are published like any other, so clients get them too.
 */
export class DeleteOrphanParts1795910400000 implements MigrationInterface {
  name = 'DeleteOrphanParts1795910400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      WITH mixed AS (
        SELECT entity, id, site_id,
               data || jsonb_strip_nulls(jsonb_build_object(
                 'id', lower(data->>'id'), 'siteId', lower(data->>'siteId'), 'ticketId', lower(data->>'ticketId')
               )) AS data,
               row_number() OVER (ORDER BY entity, id) AS n
          FROM entities
         WHERE entity IN ('ticket', 'part') AND NOT deleted
           AND (data->>'id' <> lower(data->>'id') OR data->>'siteId' <> lower(data->>'siteId')
                OR data->>'ticketId' <> lower(data->>'ticketId'))
      ),
      head AS (
        UPDATE log_head SET version = version + (SELECT count(*) FROM mixed)
         WHERE id = 1 AND EXISTS (SELECT 1 FROM mixed)
        RETURNING version
      ),
      logged AS (
        INSERT INTO change_log (version, site_id, entity, entity_id, op, data, created_at)
        SELECT head.version - (SELECT count(*) FROM mixed) + m.n, m.site_id, m.entity, m.id, 'put', m.data, now()
          FROM mixed m, head
        RETURNING entity, entity_id, version, data
      )
      UPDATE entities e SET data = logged.data, version = logged.version
        FROM logged
       WHERE e.entity = logged.entity AND e.id = logged.entity_id
    `);
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
