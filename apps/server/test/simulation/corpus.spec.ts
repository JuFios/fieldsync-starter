import { checkProfile, formatFailure, KNOWN_SIGNATURES, type CheckReport } from '@fieldsync/sim';
import { knownDefect, precondition } from '@fieldsync/test-kit';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../support/database';
import { CORPUS, PROFILES, SHRINK_TIME_MS } from './corpus';
import { RealServer } from './real-server';

const describeWithDb = hasDatabase ? describe : describe.skip;

/**
 * The CI corpus: every profile's runs against the real server on Postgres. A violation with a
 * signature the profile does not list fails with the seed, the fast-check path and a shrunk
 * scenario; listed signatures are known defects owned by later changes, each a known-defect test
 * that reports "appears fixed" once no run shows it any more.
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

  it('runs a seed twice to the same traces', async () => {
    const run = () => checkProfile({ profile: PROFILES.full, server, seed: 7, runs: 2, shrinkTimeMs: 0 });
    const first = await run();
    const second = await run();
    expect(second.results.map((r) => r.trace)).toEqual(first.results.map((r) => r.trace));
    expect(first.results).toHaveLength(2);
  });

  for (const { profile: name, seed, runs } of CORPUS) {
    const profile = PROFILES[name];

    describe(`${name}, seed ${seed}, ${runs} runs`, () => {
      let report: CheckReport | undefined;

      beforeAll(async () => {
        report = await checkProfile({ profile, server, seed, runs, shrinkTimeMs: SHRINK_TIME_MS });
      }, 300_000);

      it('shows no violation other than the known defects listed for the profile', () => {
        precondition(report !== undefined, 'the corpus did not run');
        expect(report.failure ? formatFailure(report.failure) : '').toBe('');
      });

      it('keeps the run statistics above the profile minimums', () => {
        precondition(report !== undefined && report.results.length === runs, 'the corpus did not run to the end');
        const { results } = report;
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
          `${name}: no run shows ${signature}`,
          () => {
            precondition(report !== undefined && report.results.length === runs, 'the corpus did not run to the end');
            const paths = report.results
              .map((r, path) => (r.violations.some((v) => v.signature === signature) ? path : -1))
              .filter((path) => path >= 0);
            expect(paths).toEqual([]);
          },
        );
      }
    });
  }
});
