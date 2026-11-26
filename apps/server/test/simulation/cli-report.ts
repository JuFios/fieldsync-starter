import type { CheckReport, Signature } from '@fieldsync/sim';
import type { CliProfile } from './cli-options';

export interface ProfileSummary {
  profile: CliProfile;
  ms: number;
  report: CheckReport;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The summary of one profile: runs and time, runs per signature with their paths (known defects
 * labelled as such, anything else as UNEXPECTED) and the average run statistics.
 */
export function formatProfileSummary(summary: ProfileSummary, allowed: readonly Signature[]): string {
  const { profile, ms, report } = summary;
  const runs = report.results.length;
  const clean = report.results.filter((r) => r.violations.length === 0).length;
  const lines = [
    `  ${profile}: seed ${report.seed}, ${plural(runs, 'run')} in ${(ms / 1000).toFixed(1)} s ` +
      `(${(ms / Math.max(runs, 1)).toFixed(0)} ms/run), ${clean} without violations` +
      `${report.failure ? `, stopped at path ${report.failure.path} by an unexpected violation` : ''}`,
  ];
  const bySignature = new Map<Signature, number[]>();
  report.results.forEach((r, path) => {
    for (const signature of new Set(r.violations.map((v) => v.signature))) {
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), path]);
    }
  });
  for (const [signature, paths] of bySignature) {
    const label = allowed.includes(signature) ? 'known defect' : 'UNEXPECTED';
    const shown = paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, +${paths.length - 10}` : '');
    lines.push(`    ${signature} (${label}): ${plural(paths.length, 'run')}, paths ${shown}`);
  }
  const totals: Record<string, number> = {};
  for (const r of report.results) {
    for (const [key, value] of Object.entries(r.stats)) totals[key] = (totals[key] ?? 0) + value;
  }
  const averages = Object.entries(totals)
    .map(([key, total]) => `${key}=${(total / Math.max(runs, 1)).toFixed(2)}`)
    .sort();
  lines.push(`    per run: ${averages.join(' ')}`);
  return lines.join('\n');
}

function duration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** A progress line for stderr: runs done of the total, the rate and an estimate of the time left. */
export function formatProgress(profile: string, done: number, total: number, elapsedMs: number): string {
  const head = `  ${profile}: ${done}/${total} runs (${Math.floor((done * 100) / Math.max(total, 1))}%)`;
  if (done === 0 || elapsedMs <= 0) return head;
  const perSecond = (done * 1000) / elapsedMs;
  const left = done >= total ? 'done' : `about ${duration(((total - done) * elapsedMs) / done)} left`;
  return `${head}, ${perSecond.toFixed(1)} runs/s, ${left}`;
}
