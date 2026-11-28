import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `clients.retired_at`: a client id its owner gave up (after a 409 MUTATION_OUT_OF_ORDER the client
 * continues under a new id). A retired id applies no new mutation, so a late copy of an old request
 * cannot apply anything under it. A nullable column without a default changes only the catalog.
 */
export class RetiredClients1796342400000 implements MigrationInterface {
  name = 'RetiredClients1796342400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE clients ADD COLUMN retired_at timestamptz`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE clients DROP COLUMN retired_at`);
  }
}
