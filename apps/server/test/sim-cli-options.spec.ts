import { CommanderError } from '@commander-js/extra-typings';
import { PROFILES } from '@fieldsync/sim';
import { EXIT, parseCliOptions, PROFILE_NAMES } from './simulation/cli-options';

/** Parses with commander's output captured instead of printed. */
function parse(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { writeOut: (t: string) => out.push(t), writeErr: (t: string) => err.push(t) };
  try {
    return { options: parseCliOptions(argv, '1.2.3', io), out: out.join(''), err: err.join('') };
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    return { error, out: out.join(''), err: err.join('') };
  }
}

describe('npm run sim options', () => {
  it('lists the same profiles as the simulation engine', () => {
    expect([...PROFILE_NAMES].sort()).toEqual(Object.keys(PROFILES).sort());
  });

  it('runs every profile, 100 runs, shrinking for two minutes, with a printed default seed', () => {
    const { options } = parse([]);
    expect(options).toMatchObject({
      profiles: ['baseline', 'rejections', 'multi-site', 'full'],
      runs: 100,
      shrinkMs: 120_000,
      trace: false,
    });
    expect(Number.isSafeInteger(options?.seed)).toBe(true);
  });

  it('replays one scenario of one profile from its seed and path', () => {
    const { options } = parse(['--profile', 'baseline', '--seed', '-17', '--path', '4:0:2', '--replay-path', 'AAB:C']);
    expect(options).toMatchObject({ profiles: ['baseline'], seed: -17, runs: 1, path: '4:0:2', replayPath: 'AAB:C' });
  });

  it('accepts a search size, a shrink limit and traces', () => {
    expect(parse(['--seed', '1', '--runs', '1000', '--shrink-ms', '0', '--trace']).options).toMatchObject({
      seed: 1,
      runs: 1000,
      shrinkMs: 0,
      trace: true,
    });
  });

  it.each([
    [['--help'], 'commander.helpDisplayed', /Usage: sim \[options\][\s\S]*Exit codes: 0/],
    [['--version'], 'commander.version', /^1\.2\.3\n$/],
  ])('prints %j to stdout', (argv, code, text) => {
    const { error, out, err } = parse(argv);
    expect(error?.code).toBe(code);
    expect(error?.exitCode).toBe(EXIT.ok);
    expect(out).toMatch(text);
    expect(err).toBe('');
  });

  it.each([
    [['--profile', 'nope'], /Allowed choices are baseline, rejections, multi-site, full, all/],
    [['--seed', '2147483648'], /--seed must be an integer from -2147483648 to 2147483647/],
    [['--runs', '0'], /--runs must be an integer from 1/],
    [['--runs', '1.5'], /--runs must be an integer/],
    [['--shrink-ms', 'x'], /--shrink-ms must be an integer/],
    [['--path', '1:x'], /a path is numbers separated by colons/],
    [['--path', '3'], /--path needs the --seed/],
    [['--seed', '1', '--replay-path', 'A'], /--replay-path needs --path/],
    [['--unknown'], /unknown option '--unknown'/],
    [['positional'], /too many arguments/],
  ])('rejects %j on stderr, with the usage hint', (argv, message) => {
    const { error, out, err } = parse(argv);
    expect(error).toBeInstanceOf(CommanderError);
    expect(error?.exitCode).not.toBe(EXIT.ok);
    expect(err).toMatch(message);
    expect(err).toContain('(add --help for usage)');
    expect(out).toBe('');
  });
});
