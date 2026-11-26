import { formatFailure, KNOWN_SIGNATURES, minimizeRun, runScenario, type RunResult } from '@fieldsync/sim';
import { knownDefect, precondition } from '@fieldsync/test-kit';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../support/database';
import { CORPUS, MINIMIZE_REPLAYS, PROFILES, seedRange } from './corpus';
import { RealServer } from './real-server';

const describeWithDb = hasDatabase ? describe : describe.skip;

/**
 * The CI corpus: every profile's seed range against the real server on Postgres. Violations with a
 * signature the profile does not list fail the run with the seed and a minimised scenario; listed
 * signatures are known defects owned by later changes, each a known-defect test that reports
 * "appears fixed" once no seed shows it any more.
 */
describeWithDb('simulation corpus (real server, Postgres)', () => {
  let database: TestDatabase;
  let server: RealServer;

  beforeAll(async () => {
    database = await createTestDatabase();
    server = await RealServer.start(database.url);
  });
  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it('runs a seed twice to the same trace and replays its script to the same trace', async () => {
    const first = await runScenario({ seed: 7, profile: PROFILES.full, server });
    const second = await runScenario({ seed: 7, profile: PROFILES.full, server });
    const replay = await runScenario({ seed: 7, profile: PROFILES.full, server, script: first.script });
    expect(second.trace).toEqual(first.trace);
    expect(replay.traceHash).toBe(first.traceHash);
  });

  for (const { profile: name, seeds } of CORPUS) {
    const profile = PROFILES[name];

    describe(`${name}, seeds 1-${seeds}`, () => {
      const results: RunResult[] = [];

      beforeAll(async () => {
        for (const seed of seedRange(seeds)) results.push(await runScenario({ seed, profile, server }));
      }, 300_000);

      it('shows no violation other than the known defects listed for the profile', async () => {
        const unexpected = results.flatMap((r) =>
          r.violations.filter((v) => !profile.allowed.includes(v.signature)).map((v) => ({ r, v })),
        );
        const first = unexpected[0];
        if (!first) return;
        const minimized = await minimizeRun(first.r, first.v.signature, profile, server, MINIMIZE_REPLAYS);
        const report = [
          `${unexpected.length} unexpected violation(s) in seeds ${[...new Set(unexpected.map((u) => u.r.seed))].join(', ')}`,
          formatFailure(first.r, minimized),
        ].join('\n');
        expect(report).toBe('');
      }, 300_000);

      it('keeps the run statistics above the profile minimums', () => {
        precondition(results.length === seeds, 'the corpus did not run');
        const average = (key: string) => results.reduce((sum, r) => sum + (r.stats[key] ?? 0), 0) / results.length;
        const below = Object.entries(profile.minimumPerSeed)
          .filter(([key, min]) => average(key) < min)
          .map(([key, min]) => `${key}: ${average(key).toFixed(2)} < ${min}`);
        expect(below).toEqual([]);
      });

      for (const signature of profile.allowed) {
        const known = KNOWN_SIGNATURES[signature];
        if (!known) throw new Error(`profile ${name} allows ${signature}, which has no known-defect entry`);
        knownDefect(
          { id: known.defect, owner: known.owner, reason: known.reason },
          `${name}: no seed shows ${signature}`,
          () => {
            precondition(results.length === seeds, 'the corpus did not run');
            const seedsWith = results
              .filter((r) => r.violations.some((v) => v.signature === signature))
              .map((r) => r.seed);
            expect(seedsWith).toEqual([]);
          },
        );
      }
    });
  }
});
