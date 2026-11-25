import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type Role = 'admin' | 'technician';

export interface TestUser {
  id: string;
  role: Role;
  token: string;
}

/**
 * Writes test data straight into the database, independently of the server code under test.
 * Every call creates fresh ids, so tests in one file never depend on each other's data.
 */
export class Fixtures {
  constructor(private readonly db: Pool) {}

  async site(name = 'Site'): Promise<string> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO sites (id, name) VALUES ($1, $2)`, [id, `${name} ${id.slice(0, 8)}`]);
    return id;
  }

  async user(role: Role, sites: string[] = []): Promise<TestUser> {
    const id = randomUUID();
    const token = randomBytes(24).toString('hex');
    await this.db.query(`INSERT INTO users (id, name, role, token) VALUES ($1, $2, $3, $4)`, [
      id,
      `${role} ${id.slice(0, 8)}`,
      role,
      token,
    ]);
    for (const site of sites) {
      await this.db.query(`INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)`, [id, site]);
    }
    return { id, role, token };
  }

  /** A technician with access to exactly the given sites. */
  technician(...sites: string[]): Promise<TestUser> {
    return this.user('technician', sites);
  }

  admin(): Promise<TestUser> {
    return this.user('admin');
  }
}
