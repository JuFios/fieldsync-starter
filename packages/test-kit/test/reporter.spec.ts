import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import KnownDefectReporter, { collectKnownDefects, formatSummary, type RunResults } from '../src/reporter';

const RESULTS: RunResults = {
  testResults: [
    {
      testFilePath: '/repo/a.spec.ts',
      testResults: [
        { title: 'ordinary test', status: 'passed' },
        { title: '[known defect F-10 -> PR5] keeps the queue across a reload', status: 'passed' },
      ],
    },
    {
      testFilePath: '/repo/b.spec.ts',
      testResults: [{ title: '[known defect F-07 -> PR6] filters by site', status: 'failed' }],
    },
  ],
};

describe('known-defect reporter', () => {
  it('collects only known-defect tests, sorted by id', () => {
    expect(collectKnownDefects(RESULTS)).toEqual([
      { id: 'F-07', owner: 'PR6', title: '[known defect F-07 -> PR6] filters by site', status: 'failed', file: '/repo/b.spec.ts' },
      {
        id: 'F-10',
        owner: 'PR5',
        title: '[known defect F-10 -> PR5] keeps the queue across a reload',
        status: 'passed',
        file: '/repo/a.spec.ts',
      },
    ]);
  });

  it('prints a count and one line per defect', () => {
    expect(formatSummary('core', collectKnownDefects(RESULTS))).toBe(
      'Known defects (core): 2\n' +
        '  F-07 -> PR6 [failed] filters by site\n' +
        '  F-10 -> PR5 [passed] keeps the queue across a reload\n',
    );
    expect(formatSummary('core', [])).toBe('Known defects (core): 0\n');
  });

  it('appends a Markdown table to the GitHub step summary when available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kd-'));
    const file = join(dir, 'summary.md');
    const previous = process.env.GITHUB_STEP_SUMMARY;
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.GITHUB_STEP_SUMMARY = file;
    try {
      new KnownDefectReporter({}, { label: 'core' }).onRunComplete(undefined, RESULTS);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Known defects (core): 2'));
      const markdown = readFileSync(file, 'utf8');
      expect(markdown).toContain('### Known defects (core): 2');
      expect(markdown).toContain('| F-07 | PR6 | failed | filters by site |');
    } finally {
      write.mockRestore();
      if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
