import {
  formatFailure,
  minimizeRun,
  PROFILES,
  runScenario,
  type Profile,
  type RunResult,
  type Signature,
} from '../src';
import { MemoryServer, type Defect } from './support/memory-server';

const SEEDS = Array.from({ length: 15 }, (_, i) => i + 1);

async function runAll(profile: Profile, defects: Defect[] = [], seeds = SEEDS): Promise<RunResult[]> {
  const server = new MemoryServer(new Set(defects));
  const results: RunResult[] = [];
  for (const seed of seeds) results.push(await runScenario({ seed, profile, server }));
  return results;
}

const signatures = (results: RunResult[]) => new Set(results.flatMap((r) => r.violations.map((v) => v.signature)));

describe('simulation engine (against the in-memory reference server)', () => {
  describe('reproducibility', () => {
    it('runs a seed twice to the same trace', async () => {
      const server = new MemoryServer();
      const first = await runScenario({ seed: 3, profile: PROFILES.full, server });
      const second = await runScenario({ seed: 3, profile: PROFILES.full, server });
      expect(second.trace).toEqual(first.trace);
      expect(second.traceHash).toBe(first.traceHash);
    });

    it('replays a recorded script to the same trace', async () => {
      const server = new MemoryServer();
      const recorded = await runScenario({ seed: 5, profile: PROFILES.rejections, server });
      const replayed = await runScenario({ seed: 5, profile: PROFILES.rejections, server, script: recorded.script });
      expect(replayed.traceHash).toBe(recorded.traceHash);
      expect(replayed.script).toEqual(recorded.script);
    });

    it('gives different seeds different runs', async () => {
      const hashes = new Set((await runAll(PROFILES.baseline, [], [1, 2, 3, 4, 5])).map((r) => r.traceHash));
      expect(hashes.size).toBe(5);
    });

    it('records the trace in semantic terms only (no host time or randomness)', async () => {
      const [result] = await runAll(PROFILES.baseline, [], [1]);
      const text = result?.trace.join('\n') ?? '';
      expect(text).not.toMatch(/20(2[0-9]|1[0-9])-\d\d-\d\dT/); // no wall-clock timestamps (virtual time starts in 2030)
      expect(text).toContain('seed 1 profile baseline');
    });
  });

  describe('a correct server', () => {
    it.each(['baseline', 'rejections', 'multi-site'] as const)('converges on every seed of %s', async (name) => {
      const results = await runAll(PROFILES[name]);
      expect(results.filter((r) => r.violations.length > 0).map((r) => formatFailure(r))).toEqual([]);
      expect(results.every((r) => r.quiescent)).toBe(true);
    });

    it('only ever gets stuck on hung requests in the full profile', async () => {
      const found = signatures(await runAll(PROFILES.full));
      expect([...found]).toEqual(['stuck-request']);
    });

    it.each(Object.keys(PROFILES) as Array<keyof typeof PROFILES>)(
      'keeps the %s profile above its minimum statistics',
      async (name) => {
        const profile = PROFILES[name];
        const results = await runAll(profile);
        const average = (key: string) => results.reduce((sum, r) => sum + (r.stats[key] ?? 0), 0) / results.length;
        const below = Object.entries(profile.minimumPerSeed)
          .filter(([key, min]) => average(key) < min)
          .map(([key, min]) => `${key}: ${average(key).toFixed(2)} < ${min}`);
        expect(below).toEqual([]);
      },
    );
  });

  describe('detection', () => {
    const cases: Array<[string, keyof typeof PROFILES, Defect | undefined, Signature]> = [
      ['a row that never reaches the clients', 'baseline', 'drop-first-row', 'divergence'],
      ['a rejected mutation answered with 500', 'rejections', 'rejection-500', 'rejected-mutation-500'],
      ["other sites' rows in incremental pulls", 'multi-site', 'foreign-rows', 'foreign-site-rows'],
      ['a server that never accepts a push', 'baseline', 'push-unavailable', 'livelock'],
      ['a request that never answers', 'full', undefined, 'stuck-request'],
      ['client code that throws', 'rejections', 'corrupt-status', 'client-error'],
    ];

    it.each(cases)('reports %s', async (_label, profile, defect, signature) => {
      const found = signatures(await runAll(PROFILES[profile], defect ? [defect] : []));
      expect(found).toContain(signature);
    });
  });

  describe('minimisation', () => {
    it('shrinks a failing run to fewer steps that fail the same way', async () => {
      const server = new MemoryServer(new Set<Defect>(['drop-first-row']));
      const failing = await runScenario({ seed: 2, profile: PROFILES.baseline, server });
      expect(failing.violations.map((v) => v.signature)).toContain('divergence');

      const minimized = await minimizeRun(failing, 'divergence', PROFILES.baseline, server, 200);
      expect(minimized.result.violations.map((v) => v.signature)).toContain('divergence');
      expect(minimized.result.script.length).toBeLessThan(failing.script.length / 4);

      const report = formatFailure(failing, minimized);
      expect(report).toContain('profile baseline, seed 2');
      expect(report).toContain('npm run sim -- --profile baseline --seed 2');
      expect(report).toContain(`Minimised to ${minimized.result.script.length} of ${failing.script.length} steps`);
    });
  });
});
