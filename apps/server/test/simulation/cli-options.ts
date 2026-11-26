import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';

/**
 * Profile names, as in `@fieldsync/sim` (the CLI test checks they match). Listed here so that
 * `--help` and option errors do not load the simulation engine.
 */
export const PROFILE_NAMES = ['baseline', 'rejections', 'multi-site', 'full'] as const;
export type CliProfile = (typeof PROFILE_NAMES)[number];

export interface CliOptions {
  profiles: CliProfile[];
  seed: number;
  runs: number;
  path?: string;
  replayPath?: string;
  shrinkMs: number;
  trace: boolean;
}

/** Exit codes, as listed in the help text. */
export const EXIT = { ok: 0, violations: 1, usage: 2, interrupted: 130 } as const;

function integer(name: string, min: number, max: number) {
  return (text: string): number => {
    const value = /^-?\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new InvalidArgumentError(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
  };
}

function fastCheckPath(text: string): string {
  if (!/^\d+(:\d+)*$/.test(text)) throw new InvalidArgumentError('a path is numbers separated by colons, e.g. 12:3:0.');
  return text;
}

/** A seed for runs without --seed, printed so the search can be repeated. */
export function defaultSeed(): number {
  return Date.now() % 0x8000_0000;
}

/**
 * The `sim` command line (commander). Parsing never exits the process: errors, help and version
 * throw a `CommanderError` (`exitOverride`), which the entry point turns into an exit code.
 */
export function createProgram(version: string) {
  return new Command('sim')
    .description(
      'Runs the deterministic simulation (fast-check model-based tests) against the real server on a\n' +
        'throw-away Postgres database (created from DATABASE_URL, migrated, dropped at the end) and reports\n' +
        'violations by signature. Results go to stdout, progress to stderr.',
    )
    .version(version, '-v, --version', 'show the version')
    .helpOption('-h, --help', 'show this help')
    .addOption(
      new Option('--profile <name>', 'profile to run').choices([...PROFILE_NAMES, 'all'] as const).default('all'),
    )
    .addOption(
      new Option(
        '--seed <n>',
        'fast-check seed of the search (default: derived from the current time, printed)',
      ).argParser(integer('--seed', -0x8000_0000, 0x7fff_ffff)),
    )
    .addOption(
      new Option('--runs <n>', 'scenarios per profile (default: 100, or 1 with --path)').argParser(
        integer('--runs', 1, 1_000_000),
      ),
    )
    .addOption(
      new Option('--path <path>', 'replay the scenario at this fast-check path (needs --seed)').argParser(
        fastCheckPath,
      ),
    )
    .addOption(new Option('--replay-path <hint>', "fast-check's replayPath printed with a failure (with --path)"))
    .addOption(
      new Option('--shrink-ms <ms>', 'time fast-check may spend shrinking a failure; 0 does not shrink')
        .argParser(integer('--shrink-ms', 0, 86_400_000))
        .default(120_000),
    )
    .option('--trace', 'print the full trace of every failing scenario, or of the only scenario run', false)
    .addHelpText(
      'after',
      `
Exit codes: ${EXIT.ok} no unexpected violation, ${EXIT.violations} unexpected violations, ${EXIT.usage} invalid options, ${EXIT.interrupted} interrupted.

Examples:
  npm run sim -- --runs 1000 --seed 1
  npm run sim -- --profile baseline --seed 17 --path 4 --trace
  npm run sim -- --profile rejections --runs 200 --shrink-ms 300000`,
    )
    .showHelpAfterError('(add --help for usage)')
    .exitOverride();
}

/** Parses `argv` (user arguments only); throws a `CommanderError` for invalid options, help and version. */
export function parseCliOptions(
  argv: readonly string[],
  version = '0.0.0',
  output?: { writeOut(text: string): void; writeErr(text: string): void },
): CliOptions {
  const program = createProgram(version);
  if (output) program.configureOutput(output);
  program.parse([...argv], { from: 'user' });
  const values = program.opts();
  if (values.path !== undefined && values.seed === undefined)
    program.error('error: --path needs the --seed it was found with', { exitCode: EXIT.usage });
  if (values.replayPath !== undefined && values.path === undefined)
    program.error('error: --replay-path needs --path', { exitCode: EXIT.usage });
  return {
    profiles: values.profile === 'all' ? [...PROFILE_NAMES] : [values.profile],
    seed: values.seed ?? defaultSeed(),
    runs: values.runs ?? (values.path !== undefined ? 1 : 100),
    path: values.path,
    replayPath: values.replayPath,
    shrinkMs: values.shrinkMs,
    trace: values.trace,
  };
}
