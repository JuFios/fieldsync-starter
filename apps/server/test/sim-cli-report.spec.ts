import type { CheckReport, RunResult, Violation } from '@fieldsync/sim';
import { formatProfileSummary, formatProgress } from './simulation/cli-report';

function run(violations: Violation[], stats: Record<string, number>): RunResult {
  return { profile: 'full', script: [], violations, quiescent: true, stats, trace: [], traceHash: '' };
}

const rejected: Violation = { signature: 'rejected-mutation-500', clients: ['c0'], detail: 'push answered 500' };
const livelock: Violation = { signature: 'livelock', clients: ['c1'], detail: 'queue never drained' };

describe('npm run sim report', () => {
  describe('formatProfileSummary', () => {
    it('counts runs per signature with their paths, labels known and unexpected ones, and averages the statistics', () => {
      const report: CheckReport = {
        seed: 1,
        results: [
          run([], { steps: 10 }),
          run([rejected, rejected], { steps: 20, serverRejections: 2 }),
          run([rejected, livelock], { steps: 30 }),
        ],
      };
      expect(formatProfileSummary({ profile: 'full', ms: 3_000, report }, ['rejected-mutation-500'])).toBe(
        [
          '  full: seed 1, 3 runs in 3.0 s (1000 ms/run), 1 without violations',
          '    rejected-mutation-500 (known defect): 2 runs, paths 1, 2',
          '    livelock (UNEXPECTED): 1 run, paths 2',
          '    per run: serverRejections=0.67 steps=20.00',
        ].join('\n'),
      );
    });

    it('says where an unexpected violation stopped the search and shortens long path lists', () => {
      const results = Array.from({ length: 12 }, () => run([livelock], {}));
      const last = run([livelock], {});
      results[11] = last;
      const report: CheckReport = {
        seed: 7,
        results,
        failure: {
          seed: 7,
          path: '11',
          result: last,
          unexpected: [livelock],
          foundSteps: 0,
          shrinks: 0,
          shrinkComplete: false,
        },
      };
      const text = formatProfileSummary({ profile: 'baseline', ms: 1_200, report }, []);
      expect(text).toContain('0 without violations, stopped at path 11 by an unexpected violation');
      expect(text).toContain('livelock (UNEXPECTED): 12 runs, paths 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, +2');
    });

    it('names the replayed path, not its index in the replay, when one run was replayed with --path', () => {
      const report: CheckReport = { seed: 1, results: [run([rejected], {})] };
      const text = formatProfileSummary({ profile: 'full', ms: 500, report }, ['rejected-mutation-500'], '3');
      expect(text).toContain('rejected-mutation-500 (known defect): 1 run, paths 3');
    });

    it('reports a profile that ran no scenario without dividing by zero', () => {
      const text = formatProfileSummary({ profile: 'baseline', ms: 0, report: { seed: 1, results: [] } }, []);
      expect(text).toBe('  baseline: seed 1, 0 runs in 0.0 s (0 ms/run), 0 without violations\n    per run: ');
    });
  });

  describe('formatProgress', () => {
    it('shows done and total, the rate and the time left', () => {
      expect(formatProgress('rejections', 250, 1000, 100_000)).toBe(
        '  rejections: 250/1000 runs (25%), 2.5 runs/s, about 5 min left',
      );
    });

    it('rounds short times to seconds and says when nothing is left', () => {
      expect(formatProgress('baseline', 50, 60, 10_000)).toBe(
        '  baseline: 50/60 runs (83%), 5.0 runs/s, about 2 s left',
      );
      expect(formatProgress('baseline', 60, 60, 12_000)).toBe('  baseline: 60/60 runs (100%), 5.0 runs/s, done');
    });

    it('gives no rate before any time has passed', () => {
      expect(formatProgress('full', 0, 10, 0)).toBe('  full: 0/10 runs (0%)');
    });
  });
});
