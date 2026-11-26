/* eslint-disable no-console -- a command-line entry point: results go to stdout, progress to stderr */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatFailure,
  KNOWN_SIGNATURES,
  minimizeRun,
  PROFILES,
  runScenario,
  type ProfileName,
  type RunResult,
  type Signature,
} from '@fieldsync/sim';
import { loadDotEnv } from '../../src/config';
import { createDataSource } from '../../src/database/data-source';
import { runMigrations } from '../../src/database/migrator';
import {
  dropDatabase,
  newDatabaseName,
  quoteIdent,
  startRun,
  urlFor,
  withMaintenanceClient,
} from '../support/database';
import { parseCliOptions, USAGE, UsageError, type CliOptions } from './cli-options';
import { RealServer } from './real-server';

let interrupted = false;

function version(): string {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as { version: string };
  return manifest.version;
}

/** A migrated throw-away database next to DATABASE_URL, named so the test suites' cleanup removes leftovers. */
async function createDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  startRun();
  const name = newDatabaseName('sim');
  await withMaintenanceClient((c) => c.query(`CREATE DATABASE ${quoteIdent(name)}`));
  const url = urlFor(name);
  const ds = createDataSource({ url, poolSize: 1, applicationName: 'fieldsync-sim-setup' });
  await ds.initialize();
  try {
    await runMigrations(ds);
  } finally {
    await ds.destroy();
  }
  return { url, drop: () => withMaintenanceClient((c) => dropDatabase(c, name)) };
}

interface ProfileSummary {
  profile: ProfileName;
  seeds: number;
  ms: number;
  clean: number;
  bySignature: Map<Signature, number[]>;
  unexpected: RunResult[];
  stats: Record<string, number>;
}

async function runProfile(name: ProfileName, options: CliOptions, server: RealServer): Promise<ProfileSummary> {
  const profile = PROFILES[name];
  const started = Date.now();
  const summary: ProfileSummary = {
    profile: name,
    seeds: 0,
    ms: 0,
    clean: 0,
    bySignature: new Map(),
    unexpected: [],
    stats: {},
  };
  for (let i = 0; i < options.runs && !interrupted; i += 1) {
    const seed = options.firstSeed + i;
    const result = await runScenario({ seed, profile, server });
    summary.seeds += 1;
    for (const [key, value] of Object.entries(result.stats)) summary.stats[key] = (summary.stats[key] ?? 0) + value;
    if (result.violations.length === 0) summary.clean += 1;
    for (const signature of new Set(result.violations.map((v) => v.signature))) {
      summary.bySignature.set(signature, [...(summary.bySignature.get(signature) ?? []), seed]);
    }
    if (result.violations.some((v) => !profile.allowed.includes(v.signature))) {
      summary.unexpected.push(result);
      console.log(formatFailure(result), '\n');
    }
    if (options.trace && (options.runs === 1 || result.violations.length > 0)) {
      console.log(`Trace of ${name} seed ${seed}:\n${result.trace.join('\n')}\n`);
    }
    if ((i + 1) % 50 === 0) console.error(`  ${name}: ${i + 1}/${options.runs} seeds`);
  }
  const first = summary.unexpected[0];
  const firstSignature = first?.violations.find((v) => !profile.allowed.includes(v.signature))?.signature;
  if (options.minimize && first && firstSignature && !interrupted) {
    console.error(`  ${name}: minimising seed ${first.seed} (${options.replays} replays at most)`);
    const minimized = await minimizeRun(first, firstSignature, profile, server, options.replays);
    console.log(formatFailure(first, minimized), '\n');
  }
  summary.ms = Date.now() - started;
  return summary;
}

function printSummary(summaries: ProfileSummary[]): void {
  console.log('Summary');
  for (const s of summaries) {
    const profile = PROFILES[s.profile];
    console.log(
      `  ${s.profile}: ${s.seeds} seeds in ${(s.ms / 1000).toFixed(1)} s (${(s.ms / Math.max(s.seeds, 1)).toFixed(0)} ms/seed), ` +
        `${s.clean} without violations`,
    );
    for (const [signature, seeds] of s.bySignature) {
      const known = KNOWN_SIGNATURES[signature];
      const label = profile.allowed.includes(signature)
        ? `known defect ${known?.defect ?? '?'} -> ${known?.owner ?? '?'}`
        : 'UNEXPECTED';
      const shown = seeds.slice(0, 10).join(', ') + (seeds.length > 10 ? `, +${seeds.length - 10}` : '');
      console.log(`    ${signature} (${label}): ${seeds.length} seeds, e.g. ${shown}`);
    }
    const averages = Object.entries(s.stats)
      .filter(([key]) => key in profile.minimumPerSeed || key.startsWith('action:') || key === 'serverRejections')
      .map(([key, total]) => `${key}=${(total / Math.max(s.seeds, 1)).toFixed(2)}`)
      .sort();
    console.log(`    per seed: ${averages.join(' ')}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`sim: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(version());
    return 0;
  }
  loadDotEnv();
  if (!process.env.DATABASE_URL) {
    console.error(
      'sim: DATABASE_URL is not set. Start Postgres (docker compose up -d postgres) and set it, see the README.',
    );
    return 2;
  }

  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error('\nsim: interrupted, finishing the current seed and cleaning up (Ctrl+C again to quit now)');
  };
  process.on('SIGINT', onSigint);

  const database = await createDatabase();
  let server: RealServer | undefined;
  const summaries: ProfileSummary[] = [];
  try {
    server = await RealServer.start(database.url);
    for (const name of options.profiles) {
      if (interrupted) break;
      console.error(`sim: ${name}, seeds ${options.firstSeed}-${options.firstSeed + options.runs - 1}`);
      summaries.push(await runProfile(name, options, server));
    }
  } finally {
    await server?.close();
    await database.drop();
    process.off('SIGINT', onSigint);
  }
  printSummary(summaries);
  if (interrupted) return 130;
  return summaries.some((s) => s.unexpected.length > 0) ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('sim: failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  },
);
