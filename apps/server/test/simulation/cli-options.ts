import { parseArgs } from 'node:util';
import { parseSeed, PROFILES, type ProfileName } from '@fieldsync/sim';

export const USAGE = `Usage: npm run sim -- [options]

Runs the deterministic simulation against the real server on a throw-away Postgres database
(created from DATABASE_URL, migrated, dropped at the end) and reports violations by signature.

Options:
  --profile <name>  ${Object.keys(PROFILES).join(' | ')} | all (default: all)
  --seed <n>        first seed to run (default: 1)
  --runs <n>        seeds per profile, starting at --seed (default: 1 with --seed, else 100)
  --minimize        minimise the first unexpected failure of each profile
  --replays <n>     replay budget of the minimiser (default: 200)
  --trace           print the full trace of every failing seed, or of the only seed run
  -h, --help        show this help
  -v, --version     show the version

Exit codes: 0 no unexpected violation, 1 unexpected violations, 2 invalid options, 130 interrupted.

Examples:
  npm run sim -- --runs 1000
  npm run sim -- --profile baseline --seed 17 --trace
  npm run sim -- --profile rejections --runs 200 --minimize`;

export interface CliOptions {
  help: boolean;
  version: boolean;
  profiles: ProfileName[];
  firstSeed: number;
  runs: number;
  minimize: boolean;
  replays: number;
  trace: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function positiveInteger(text: string, flag: string, max: number): number {
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new UsageError(`${flag} must be an integer from 1 to ${max}, got "${text}"`);
  }
  return value;
}

/** Parses and validates the command line; throws {@link UsageError} with a message for the user. */
export function parseCliOptions(argv: readonly string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        profile: { type: 'string' },
        seed: { type: 'string' },
        runs: { type: 'string' },
        minimize: { type: 'boolean', default: false },
        replays: { type: 'string' },
        trace: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values } = parsed;
  const profileName = values.profile ?? 'all';
  if (profileName !== 'all' && !(profileName in PROFILES)) {
    throw new UsageError(`unknown profile "${profileName}"; use one of ${Object.keys(PROFILES).join(', ')} or all`);
  }
  let firstSeed = 1;
  if (values.seed !== undefined) {
    try {
      firstSeed = parseSeed(values.seed);
    } catch (err) {
      throw new UsageError(`--seed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const runs = values.runs !== undefined ? positiveInteger(values.runs, '--runs', 1_000_000) : values.seed ? 1 : 100;
  if (firstSeed + runs - 1 > 0xffff_ffff)
    throw new UsageError('--seed plus --runs goes past the largest seed, 4294967295');
  return {
    help: values.help,
    version: values.version,
    profiles: profileName === 'all' ? (Object.keys(PROFILES) as ProfileName[]) : [profileName as ProfileName],
    firstSeed,
    runs,
    minimize: values.minimize,
    replays: values.replays !== undefined ? positiveInteger(values.replays, '--replays', 100_000) : 200,
    trace: values.trace,
  };
}
