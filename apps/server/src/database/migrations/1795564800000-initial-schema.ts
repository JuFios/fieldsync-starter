import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema of the original code base, unchanged. Every statement is idempotent (IF NOT EXISTS),
 * so the migration also adopts a database the original server created at startup: it records
 * itself without touching existing tables or data.
 */
export class InitialSchema1795564800000 implements MigrationInterface {
  name = 'InitialSchema1795564800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id uuid PRIMARY KEY,
        name text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'technician')),
        token text NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS user_sites (
        user_id uuid NOT NULL REFERENCES users (id),
        site_id uuid NOT NULL REFERENCES sites (id),
        PRIMARY KEY (user_id, site_id)
      );
      CREATE TABLE IF NOT EXISTS entities (
        entity text NOT NULL,
        id uuid NOT NULL,
        site_id uuid NOT NULL,
        data jsonb,
        deleted boolean NOT NULL DEFAULT false,
        version bigint NOT NULL,
        PRIMARY KEY (entity, id)
      );
      CREATE INDEX IF NOT EXISTS entities_site_idx ON entities (site_id);
      CREATE TABLE IF NOT EXISTS change_log (
        version bigserial PRIMARY KEY,
        site_id uuid NOT NULL,
        entity text NOT NULL,
        entity_id uuid NOT NULL,
        op text NOT NULL,
        data jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS change_log_created_idx ON change_log (created_at);
      CREATE TABLE IF NOT EXISTS clients (
        client_id text PRIMARY KEY,
        user_id uuid NOT NULL,
        last_mutation_id bigint NOT NULL DEFAULT 0
      );
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS clients, change_log, entities, user_sites, users, sites`);
  }
}
