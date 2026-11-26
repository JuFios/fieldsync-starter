import { randomUUID } from 'node:crypto';
import { checkProfile, PROFILES } from '@fieldsync/sim';
import { MUTATORS, type MutatorDef } from '@fieldsync/sync-core';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../support/database';
import { RealServer } from './real-server';

const describeWithDb = hasDatabase ? describe : describe.skip;

/**
 * Checks of the harness itself: with a determinism defect put back into the shared mutators (both
 * the simulated clients and the server run this process's copy of sync-core), the simulation must
 * fail. Each test restores the mutator afterwards.
 */
describeWithDb('the simulation finds the determinism defects when they are put back', () => {
  let database: TestDatabase;
  let server: RealServer;
  const original: MutatorDef = MUTATORS['ticket.create'];

  beforeAll(async () => {
    database = await createTestDatabase();
    server = await RealServer.start(database.url);
  });
  afterEach(() => {
    MUTATORS['ticket.create'] = original;
  });
  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it('fails a baseline run when ticket.create makes up its own id (F-19)', async () => {
    MUTATORS['ticket.create'] = {
      reads: (args) => original.reads(args),
      apply: (tx, args) => original.apply(tx, { ...args, id: randomUUID() }),
    };
    const report = await checkProfile({ profile: PROFILES.baseline, server, seed: 1, runs: 5, shrinkTimeMs: 0 });
    expect(report.failure?.unexpected.length).toBeGreaterThan(0);
  }, 120_000);

  it('makes one seed give two different traces when ticket.create reads the wall clock (F-20)', async () => {
    MUTATORS['ticket.create'] = {
      reads: (args) => original.reads(args),
      apply: (tx, args) =>
        original.apply(
          {
            now: () => new Date().toISOString(),
            get: (entity, id) => tx.get(entity, id),
            put: (entity, id, row) => tx.put(entity, id, row),
            insert: (entity, id, row) => tx.insert(entity, id, row),
            del: (entity, id) => tx.del(entity, id),
          },
          args,
        ),
    };
    const run = () => checkProfile({ profile: PROFILES.baseline, server, seed: 3, runs: 1, shrinkTimeMs: 0 });
    const first = await run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await run();
    expect(first.failure).toBeUndefined();
    expect(second.results[0]?.traceHash).not.toBe(first.results[0]?.traceHash);
  }, 120_000);
});
