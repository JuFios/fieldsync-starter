import { checkProfile, formatFailure, PROFILES, type CheckReport, type RunResult, type Signature } from '../src';
import { MemoryServer, type Defect } from './support/memory-server';

const SEED = 20301;

async function search(
  name: keyof typeof PROFILES,
  options: {
    defects?: Defect[];
    runs?: number;
    seed?: number;
    path?: string;
    replayPath?: string;
    shrinkTimeMs?: number;
  } = {},
): Promise<CheckReport> {
  return checkProfile({
    profile: PROFILES[name],
    server: new MemoryServer(new Set(options.defects ?? [])),
    seed: options.seed ?? SEED,
    runs: options.runs ?? 15,
    path: options.path,
    replayPath: options.replayPath,
    shrinkTimeMs: options.shrinkTimeMs ?? 0,
  });
}

/** Signatures over every run of a search that does not stop: the profile allows them all. */
async function signaturesIn(
  name: keyof typeof PROFILES,
  defects: Defect[] = [],
  overrides: Partial<(typeof PROFILES)['full']> = {},
): Promise<Set<Signature>> {
  const profile = {
    ...PROFILES[name],
    allowed: [...PROFILES.full.allowed, 'divergence', 'livelock', 'client-error', 'stuck-request'],
    ...overrides,
  };
  const report = await checkProfile({
    profile: profile as typeof PROFILES.full,
    server: new MemoryServer(new Set(defects)),
    seed: SEED,
    runs: 15,
    shrinkTimeMs: 0,
  });
  return new Set(report.results.flatMap((r) => r.violations.map((v) => v.signature)));
}

const hashes = (results: RunResult[]) => results.map((r) => r.traceHash);

describe('simulation engine (against the in-memory reference server)', () => {
  describe('reproducibility', () => {
    it('runs a seed twice to the same traces', async () => {
      const first = await search('full', { runs: 4 });
      const second = await search('full', { runs: 4 });
      expect(second.results.map((r) => r.trace)).toEqual(first.results.map((r) => r.trace));
    });

    it('replays the run at a path on its own, to the same trace', async () => {
      const all = await search('rejections', { runs: 5 });
      const replay = await search('rejections', { runs: 1, path: '3' });
      expect(hashes(replay.results)).toEqual([all.results[3]?.traceHash]);
    });

    it('gives other seeds and other runs different scenarios', async () => {
      const one = await search('baseline', { runs: 5 });
      const other = await search('baseline', { runs: 5, seed: SEED + 1 });
      expect(new Set([...hashes(one.results), ...hashes(other.results)]).size).toBe(10);
    });

    it('records the trace in semantic terms only (no host time or randomness)', async () => {
      const [result] = (await search('baseline', { runs: 1 })).results;
      const text = result?.trace.join('\n') ?? '';
      expect(text).not.toMatch(/20(2[0-9]|1[0-9])-\d\d-\d\dT/); // no wall-clock timestamps (virtual time starts in 2030)
      expect(text).toContain('profile baseline');
    });
  });

  describe('a correct server', () => {
    it.each(['baseline', 'rejections', 'multi-site'] as const)('converges on every run of %s', async (name) => {
      const report = await search(name);
      expect(report.failure ? formatFailure(report.failure) : '').toBe('');
      expect(report.results).toHaveLength(15);
      expect(report.results.every((r) => r.quiescent)).toBe(true);
    });

    it('converges on every run of full, hung requests included: the client gives up on them', async () => {
      expect([...(await signaturesIn('full'))]).toEqual([]);
    });

    it.each(Object.keys(PROFILES) as Array<keyof typeof PROFILES>)(
      'keeps the %s profile above its minimum statistics',
      async (name) => {
        const profile = PROFILES[name];
        // Averages over a larger sample: per-run values vary a lot (a run may have no conflict at all).
        const { results } = await search(name, { runs: 60 });
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
      ['client code that throws', 'rejections', 'corrupt-status', 'client-error'],
      ['an edit of the title that empties the description', 'baseline', 'blank-unsent-description', 'lost-edit'],
      ['a rejection the actions of the profile cannot cause', 'baseline', 'internal-rejection', 'unexpected-rejection'],
      ['a GC that removes changes without a floor (F-34)', 'baseline', 'compact-without-floor', 'divergence'],
      ['mutations the server never handled', 'baseline', 'forget-handled', 'lost-mutation'],
      [
        'an INTERNAL rejection even where rejections are expected',
        'rejections',
        'internal-rejection',
        'unexpected-rejection',
      ],
    ];

    it.each(cases)('reports %s', async (_label, profile, defect, signature) => {
      expect(await signaturesIn(profile, defect ? [defect] : [])).toContain(signature);
    });

    it('reports a client that waits forever on a hung request (as one without a request timeout would)', async () => {
      // No timeout, as in the client before F-13.
      const forever = { requestTimeoutMs: Number.POSITIVE_INFINITY };
      expect(await signaturesIn('full', [], forever)).toContain('stuck-request');
    });

    it('still checks the clients that drained when another client is stuck on a known defect', async () => {
      // A client stuck on a tolerated defect (here 500 for rejections) must not switch off the
      // convergence check of the others: a row that never reaches them is still a divergence.
      const profile = { ...PROFILES.rejections, allowed: ['rejected-mutation-500', 'divergence'] as Signature[] };
      const report = await checkProfile({
        profile,
        server: new MemoryServer(new Set<Defect>(['rejection-500', 'drop-first-row'])),
        seed: SEED,
        runs: 15,
        shrinkTimeMs: 0,
      });
      const both = report.results.filter((r) => {
        const signatures = new Set(r.violations.map((v) => v.signature));
        return signatures.has('rejected-mutation-500') && signatures.has('divergence');
      });
      expect(both.length).toBeGreaterThan(0);
    });

    it('names every client in a violation when no client can converge, even with a heal budget of one step', async () => {
      // Every client misses the first row; a client that did not finish catching up within the
      // budget must be reported as not drained, never silently left out of the verdict.
      const profile = {
        ...PROFILES.rejections,
        healSteps: 1,
        allowed: ['rejected-mutation-500', 'divergence', 'livelock', 'stuck-request'] as Signature[],
      };
      const report = await checkProfile({
        profile,
        server: new MemoryServer(new Set<Defect>(['rejection-500', 'drop-first-row'])),
        seed: SEED,
        runs: 15,
        shrinkTimeMs: 0,
      });
      const clients = profile.clients.map((_, i) => `c${i}`);
      const unnamed = report.results.flatMap((r, path) => {
        const named = new Set(
          r.violations.flatMap((v) => ('clients' in v ? v.clients : 'client' in v ? [v.client] : [])),
        );
        return clients.filter((c) => !named.has(c)).map((c) => `path ${path}: ${c}`);
      });
      expect(unnamed).toEqual([]);
    });

    it('stops at the first run with a violation the profile does not allow', async () => {
      const report = await search('baseline', { defects: ['drop-first-row'], runs: 50 });
      expect(report.failure?.unexpected.map((v) => v.signature)).toContain('divergence');
      expect(report.results).toHaveLength(Number(report.failure?.path) + 1);
    });
  });

  describe('shrinking', () => {
    it('shrinks a failure to fewer steps that still fail, and its seed and path replay it', async () => {
      const report = await search('baseline', { defects: ['drop-first-row'], runs: 50, shrinkTimeMs: 20_000 });
      const failure = report.failure;
      if (!failure) throw new Error('the defect was not found');
      expect(failure.unexpected.map((v) => v.signature)).toContain('divergence');
      expect(failure.shrinks).toBeGreaterThan(0);
      expect(failure.result.script.length).toBeLessThan(failure.foundSteps);

      const replay = await search('baseline', {
        defects: ['drop-first-row'],
        seed: failure.seed,
        path: failure.path,
        replayPath: failure.replayPath,
        runs: 1,
      });
      expect(replay.failure?.result.traceHash).toBe(failure.result.traceHash);

      const text = formatFailure(failure);
      expect(text).toContain(`profile baseline, seed ${SEED}, path ${failure.path}`);
      expect(text).toContain(`npm run sim -- --profile baseline --seed ${SEED} --path ${failure.path}`);
      expect(text).toContain(`shrunk from ${failure.foundSteps} to ${failure.result.script.length} steps`);
    }, 60_000);
  });
});
