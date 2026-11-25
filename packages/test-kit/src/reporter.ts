import { appendFileSync } from 'node:fs';
import { parseKnownDefectTitle } from './known-defect';

/** The subset of Jest's AggregatedResult this reporter reads. */
export interface RunResults {
  testResults: Array<{
    testFilePath: string;
    testResults: Array<{ title: string; status: string }>;
  }>;
}

export interface KnownDefectEntry {
  id: string;
  owner: string;
  title: string;
  status: string;
  file: string;
}

export interface KnownDefectReporterOptions {
  /** Shown in the summary, e.g. "server integration". */
  label?: string;
}

export function collectKnownDefects(results: RunResults): KnownDefectEntry[] {
  const entries: KnownDefectEntry[] = [];
  for (const file of results.testResults) {
    for (const test of file.testResults) {
      const parsed = parseKnownDefectTitle(test.title);
      if (parsed) entries.push({ ...parsed, title: test.title, status: test.status, file: file.testFilePath });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id) || a.title.localeCompare(b.title));
}

export function formatSummary(label: string, entries: KnownDefectEntry[]): string {
  const header = `Known defects (${label}): ${entries.length}`;
  if (entries.length === 0) return `${header}\n`;
  const lines = entries.map((e) => `  ${e.id} -> ${e.owner} [${e.status}] ${e.title.replace(/^\[[^\]]*\] /, '')}`);
  return `${header}\n${lines.join('\n')}\n`;
}

export function formatMarkdown(label: string, entries: KnownDefectEntry[]): string {
  const rows = entries.map((e) => `| ${e.id} | ${e.owner} | ${e.status} | ${e.title.replace(/^\[[^\]]*\] /, '')} |`);
  return [
    `### Known defects (${label}): ${entries.length}`,
    '',
    ...(entries.length ? ['| Id | Owner | Status | Test |', '|---|---|---|---|', ...rows] : []),
    '',
  ].join('\n');
}

/**
 * Jest reporter that lists every known-defect test of the run, so CI shows how many defects are
 * still open and which change owns each. Writes a Markdown table to the GitHub step summary when
 * `GITHUB_STEP_SUMMARY` is set.
 */
export default class KnownDefectReporter {
  private readonly label: string;

  constructor(_globalConfig: unknown, options: KnownDefectReporterOptions = {}) {
    this.label = options.label ?? 'tests';
  }

  onRunComplete(_contexts: unknown, results: RunResults): void {
    const entries = collectKnownDefects(results);
    process.stderr.write(`\n${formatSummary(this.label, entries)}`);
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) appendFileSync(summaryFile, `${formatMarkdown(this.label, entries)}\n`);
  }
}
