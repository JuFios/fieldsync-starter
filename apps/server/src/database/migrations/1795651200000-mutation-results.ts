import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The outcome of every mutation a client pushed, so that a retried or parallel copy of a mutation is
 * answered with what happened to the original: a rejection with its reason, or "duplicate" (with
 * the change-log version of its last change) for an applied one. Rows older than the change-log retention are removed by the GC (a client that old
 * has to reload its state anyway). Also makes `clients.user_id` a real reference to its user.
 */
export class MutationResults1795651200000 implements MigrationInterface {
  name = 'MutationResults1795651200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE clients ADD CONSTRAINT clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id);
      CREATE TABLE mutation_results (
        client_id text NOT NULL REFERENCES clients (client_id) ON DELETE CASCADE,
        mutation_id bigint NOT NULL CHECK (mutation_id > 0),
        status text NOT NULL CHECK (status IN ('applied', 'rejected')),
        code text,
        message text,
        details jsonb,
        -- Change-log version of the mutation's last change; NULL when it changed nothing.
        version bigint,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (client_id, mutation_id),
        CONSTRAINT mutation_results_rejection_check CHECK ((status = 'rejected') = (code IS NOT NULL AND message IS NOT NULL))
      );
      CREATE INDEX mutation_results_created_idx ON mutation_results (created_at);
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE mutation_results;
      ALTER TABLE clients DROP CONSTRAINT clients_user_id_fkey;
    `);
  }
}
