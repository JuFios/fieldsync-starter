import { MutationRejected, type Mutation } from '@fieldsync/sync-core';
import { accessibleSites, authorize } from '../src/access';

const SITE_A = '00000000-0000-4000-8000-0000000000a1';
const SITE_B = '00000000-0000-4000-8000-0000000000b1';
const TECH = { id: 'u1', role: 'technician' as const };
const ADMIN = { id: 'u0', role: 'admin' as const };

/**
 * Answers the two queries access.ts makes from an in-memory table, keyed by the user id it is given,
 * and fails on anything else so the test notices when the queries change.
 */
function fakeDb(allSites: string[], assigned: Record<string, string[]>) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (/FROM user_sites WHERE user_id = \$1/.test(sql)) {
        return { rows: (assigned[params[0] as string] ?? []).map((site_id) => ({ site_id })) };
      }
      if (/FROM sites/.test(sql)) return { rows: allSites.map((id) => ({ id })) };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as never;
}

const db = fakeDb([SITE_A, SITE_B], { [TECH.id]: [SITE_A] });

const setStatus = (args: Record<string, unknown>): Mutation => ({
  id: 1,
  name: 'ticket.setStatus',
  args: { id: 'x', status: 'done', ...args },
});

async function rejectionOf(run: Promise<void>): Promise<MutationRejected> {
  let thrown: unknown;
  try {
    await run;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(MutationRejected);
  return thrown as MutationRejected;
}

describe('accessibleSites', () => {
  it('returns only the sites assigned to a technician', async () => {
    await expect(accessibleSites(db, TECH)).resolves.toEqual([SITE_A]);
  });

  it('returns every site to an admin', async () => {
    await expect(accessibleSites(db, ADMIN)).resolves.toEqual([SITE_A, SITE_B]);
  });
});

/**
 * These tests cover the check as written: it trusts the siteId argument sent by the client. That
 * the check must use the site of the stored row instead is tested on Postgres (known defect F-08).
 */
describe('authorize', () => {
  it('allows a mutation whose siteId argument names an accessible site', async () => {
    await expect(authorize(db, TECH, setStatus({ siteId: SITE_A }))).resolves.toBeUndefined();
  });

  it('rejects a mutation whose siteId argument names an inaccessible site', async () => {
    expect((await rejectionOf(authorize(db, TECH, setStatus({ siteId: SITE_B })))).code).toBe('FORBIDDEN');
  });

  it('rejects a mutation without a usable siteId argument', async () => {
    expect((await rejectionOf(authorize(db, TECH, setStatus({})))).code).toBe('FORBIDDEN');
    expect((await rejectionOf(authorize(db, TECH, setStatus({ siteId: [SITE_A] })))).code).toBe('FORBIDDEN');
  });

  it('allows an admin on any existing site', async () => {
    await expect(authorize(db, ADMIN, setStatus({ siteId: SITE_B }))).resolves.toBeUndefined();
  });
});
