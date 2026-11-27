import { randomUUID } from 'node:crypto';
import { checkProfile, PROFILES } from '@fieldsync/sim';
import { MUTATORS, type MutatorDef } from '@fieldsync/sync-core';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../support/database';
import { RealServer } from './real-server';

const describeWithDb = hasDatabase ? describe : describe.skip;

/**
 * Checks of the harness itself: with a defect put back into the shared mutators (both
 * the simulated clients and the server run this process's copy of sync-core), the simulation must
 * fail. Each test restores the mutator afterwards.
 */
describeWithDb('the simulation finds the defects of the mutators when they are put back', () => {
  let database: TestDatabase;
  let server: RealServer;
  const original: MutatorDef = MUTATORS['ticket.create'];
  const originalUpdate: MutatorDef = MUTATORS['ticket.update'];

  beforeAll(async () => {
    database = await createTestDatabase();
    server = await RealServer.start(database.url);
  });
  afterEach(() => {
    MUTATORS['ticket.create'] = original;
    MUTATORS['ticket.update'] = originalUpdate;
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
            partsOf: (ticketId) => tx.partsOf(ticketId),
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

  it('reports a lost edit when an edit of the title empties the description, as the original ticket.update did (F-27)', async () => {
    MUTATORS['ticket.update'] = {
      reads: (args) => originalUpdate.reads(args),
      apply: (tx, args) => originalUpdate.apply(tx, { ...args, description: args.description ?? '' }),
    };
    const report = await checkProfile({ profile: PROFILES.baseline, server, seed: 1, runs: 10, shrinkTimeMs: 0 });
    expect(report.failure?.unexpected.map((v) => v.signature)).toContain('lost-edit');
  }, 120_000);
});
