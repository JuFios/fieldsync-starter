import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Finds the parts of a ticket (`ticket.delete` deletes them with it, and locks them first). Built
 * concurrently, outside a transaction, so writes to `entities` go on while it is built.
 */
export class PartTicketIndex1795824000000 implements MigrationInterface {
  name = 'PartTicketIndex1795824000000';
  transaction = false as const;

  async up(q: QueryRunner): Promise<void> {
    // A build interrupted earlier leaves an invalid index behind; start over in that case.
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS entities_part_ticket_idx`);
    await q.query(
      `CREATE INDEX CONCURRENTLY entities_part_ticket_idx ON entities ((data->>'ticketId')) WHERE entity = 'part' AND NOT deleted`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS entities_part_ticket_idx`);
  }
}
