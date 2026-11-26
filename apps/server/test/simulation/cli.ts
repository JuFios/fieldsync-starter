/* eslint-disable no-console -- a command-line entry point: results go to stdout, progress to stderr */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CommanderError } from '@commander-js/extra-typings';
import type { CheckReport, Signature } from '@fieldsync/sim';
import { EXIT, parseCliOptions, type CliOptions, type CliProfile } from './cli-options';

async function version(): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(__dirname, '../../../package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

interface ProfileSummary {
  profile: CliProfile;
  ms: number;
  report: CheckReport;
}

/**
 * Runs every chosen profile. The engine, the server and the database driver are loaded only here,
 * after the options are valid, so `--help`, `--version` and option errors start fast.
 */
async function run(options: CliOptions, signal: AbortSignal): Promise<ProfileSummary[]> {
  const [{ checkProfile, formatFailure, PROFILES }, { loadDotEnv }, { createSimulationDatabase }, { RealServer }] =
    await Promise.all([
      import('@fieldsync/sim'),
      import('../../src/config'),
      import('./sim-database'),
      import('./real-server'),
    ]);
  loadDotEnv();
  if (!process.env.DATABASE_URL) {
    throw new UsageProblem(
      'DATABASE_URL is not set. Start Postgres (docker compose up -d postgres) and set it, see the README.',
    );
  }
  const database = await createSimulationDatabase();
  const summaries: ProfileSummary[] = [];
  let server: Awaited<ReturnType<typeof RealServer.start>> | undefined;
  try {
    server = await RealServer.start(database.url);
    for (const name of options.profiles) {
      if (signal.aborted) break;
      const what = options.path === undefined ? `${options.runs} runs` : `path ${options.path}`;
      console.error(`sim: ${name}, seed ${options.seed}, ${what}`);
      const started = Date.now();
      const report = await checkProfile({
        profile: PROFILES[name],
        server,
        seed: options.seed,
        runs: options.runs,
        path: options.path,
        replayPath: options.replayPath,
        shrinkTimeMs: options.shrinkMs,
        signal,
        onRun: (result, index) => {
          if (options.trace && (options.runs === 1 || result.violations.length > 0)) {
            console.log(`Trace of ${name} seed ${options.seed} run ${index}:\n${result.trace.join('\n')}\n`);
          }
          if ((index + 1) % 50 === 0) console.error(`  ${name}: ${index + 1}/${options.runs} runs`);
        },
      });
      if (report.failure) {
        if (!report.failure.shrinkComplete && options.shrinkMs > 0 && !report.interrupted) {
          console.error(`  ${name}: shrinking stopped at the --shrink-ms limit`);
        }
        console.log(formatFailure(report.failure), '\n');
      }
      summaries.push({ profile: name, ms: Date.now() - started, report });
    }
  } finally {
    await server?.close();
    await database.drop();
  }
  return summaries;
}

/** A problem with the environment the user can fix, reported like an invalid option. */
class UsageProblem extends Error {}

function printSummary(summaries: ProfileSummary[], allowed: (profile: CliProfile) => readonly Signature[]): void {
  console.log('Summary');
  for (const { profile, ms, report } of summaries) {
    const runs = report.results.length;
    const clean = report.results.filter((r) => r.violations.length === 0).length;
    console.log(
      `  ${profile}: seed ${report.seed}, ${runs} runs in ${(ms / 1000).toFixed(1)} s ` +
        `(${(ms / Math.max(runs, 1)).toFixed(0)} ms/run), ${clean} without violations` +
        `${report.failure ? `, stopped at path ${report.failure.path} by an unexpected violation` : ''}`,
    );
    const bySignature = new Map<Signature, number[]>();
    report.results.forEach((r, path) => {
      for (const signature of new Set(r.violations.map((v) => v.signature))) {
        bySignature.set(signature, [...(bySignature.get(signature) ?? []), path]);
      }
    });
    for (const [signature, paths] of bySignature) {
      const label = allowed(profile).includes(signature) ? 'known defect' : 'UNEXPECTED';
      const shown = paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, +${paths.length - 10}` : '');
      console.log(`    ${signature} (${label}): ${paths.length} runs, paths ${shown}`);
    }
    const totals: Record<string, number> = {};
    for (const r of report.results) {
      for (const [key, value] of Object.entries(r.stats)) totals[key] = (totals[key] ?? 0) + value;
    }
    const averages = Object.entries(totals)
      .map(([key, total]) => `${key}=${(total / Math.max(runs, 1)).toFixed(2)}`)
      .sort();
    console.log(`    per run: ${averages.join(' ')}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(argv, await version());
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    // Commander has already printed the help, the version or the error.
    return err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? EXIT.ok : EXIT.usage;
  }

  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(EXIT.interrupted);
    controller.abort();
    console.error('\nsim: interrupted, finishing the current scenario and cleaning up (Ctrl+C again to quit now)');
  };
  process.on('SIGINT', onSigint);
  let summaries: ProfileSummary[];
  try {
    summaries = await run(options, controller.signal);
  } catch (err) {
    if (!(err instanceof UsageProblem)) throw err;
    console.error(`sim: ${err.message}`);
    return EXIT.usage;
  } finally {
    process.off('SIGINT', onSigint);
  }
  const { PROFILES } = await import('@fieldsync/sim');
  printSummary(summaries, (profile) => PROFILES[profile].allowed);
  if (controller.signal.aborted) return EXIT.interrupted;
  return summaries.some((s) => s.report.failure) ? EXIT.violations : EXIT.ok;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('sim: failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = EXIT.violations;
  },
);
