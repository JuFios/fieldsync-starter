import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client ids are UUIDs (every client generates one, and the API accepts nothing else since the
 * request validation), so they are stored as `uuid`. A row whose id is not a UUID belongs to a
 * client that can no longer push or pull; it is deleted with its mutation results.
 */
export class ClientIdUuid1795996800000 implements MigrationInterface {
  name = 'ClientIdUuid1795996800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM clients
       WHERE client_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      ALTER TABLE mutation_results DROP CONSTRAINT mutation_results_client_id_fkey;
      ALTER TABLE clients ALTER COLUMN client_id TYPE uuid USING client_id::uuid;
      ALTER TABLE mutation_results ALTER COLUMN client_id TYPE uuid USING client_id::uuid;
      ALTER TABLE mutation_results ADD CONSTRAINT mutation_results_client_id_fkey
        FOREIGN KEY (client_id) REFERENCES clients (client_id) ON DELETE CASCADE;
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE mutation_results DROP CONSTRAINT mutation_results_client_id_fkey;
      ALTER TABLE clients ALTER COLUMN client_id TYPE text;
      ALTER TABLE mutation_results ALTER COLUMN client_id TYPE text;
      ALTER TABLE mutation_results ADD CONSTRAINT mutation_results_client_id_fkey
        FOREIGN KEY (client_id) REFERENCES clients (client_id) ON DELETE CASCADE;
    `);
  }
}
