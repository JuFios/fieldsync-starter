/* eslint-disable no-console -- a command-line entry point: results go to stdout, progress to stderr */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CommanderError } from '@commander-js/extra-typings';
import { EXIT, parseCliOptions, type CliOptions } from './cli-options';
import { formatProfileSummary, formatProgress, type ProfileSummary } from './cli-report';

async function version(): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(__dirname, '../../../package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Runs every chosen profile and prints each profile's summary as soon as it is done, so a later
 * failure or Ctrl+C never loses the results of finished profiles. The engine, the server and the database driver are loaded only here,
 * after the options are valid, so `--help`, `--version` and option errors start fast.
 */
async function run(options: CliOptions, signal: AbortSignal): Promise<ProfileSummary[]> {
  const [{ checkProfile, formatFailure, PROFILES }, { createSimulationDatabase }, { RealServer }] = await Promise.all([
    import('@fieldsync/sim'),
    import('./sim-database'),
    import('./real-server'),
  ]);
  // Like the server: variables from .env in the working directory, where the environment wins.
  if (existsSync('.env')) process.loadEnvFile();
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
          const done = index + 1;
          if (done % 50 === 0 || done === options.runs) {
            console.error(formatProgress(name, done, options.runs, Date.now() - started));
          }
        },
      });
      if (report.failure) {
        if (!report.failure.shrinkComplete && options.shrinkMs > 0 && !report.interrupted) {
          console.error(`  ${name}: shrinking stopped at the --shrink-ms limit`);
        }
        console.log(formatFailure(report.failure), '\n');
      }
      const summary: ProfileSummary = { profile: name, ms: Date.now() - started, report };
      summaries.push(summary);
      console.log(formatProfileSummary(summary, PROFILES[name].allowed, options.path));
    }
  } finally {
    await server?.close();
    await database.drop();
  }
  return summaries;
}

/** A problem with the environment the user can fix, reported like an invalid option. */
class UsageProblem extends Error {}

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
