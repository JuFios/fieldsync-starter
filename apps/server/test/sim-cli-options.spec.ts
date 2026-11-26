import { parseCliOptions, UsageError } from './simulation/cli-options';

describe('npm run sim options', () => {
  it('runs every profile on seeds 1-100 by default', () => {
    expect(parseCliOptions([])).toEqual({
      help: false,
      version: false,
      profiles: ['baseline', 'rejections', 'multi-site', 'full'],
      firstSeed: 1,
      runs: 100,
      minimize: false,
      replays: 200,
      trace: false,
    });
  });

  it('runs a single seed of one profile when given --seed', () => {
    expect(parseCliOptions(['--profile', 'baseline', '--seed', '17', '--trace'])).toMatchObject({
      profiles: ['baseline'],
      firstSeed: 17,
      runs: 1,
      trace: true,
    });
  });

  it('accepts a range, minimisation and a replay budget', () => {
    expect(parseCliOptions(['--seed', '0x10', '--runs', '1000', '--minimize', '--replays', '50'])).toMatchObject({
      firstSeed: 16,
      runs: 1000,
      minimize: true,
      replays: 50,
    });
  });

  it.each([
    [['--profile', 'nope'], /unknown profile "nope"/],
    [['--seed', '-1'], /--seed/],
    [['--runs', '0'], /--runs must be an integer from 1/],
    [['--runs', '1.5'], /--runs must be an integer/],
    [['--replays', 'x'], /--replays must be an integer/],
    [['--seed', '4294967295', '--runs', '2'], /past the largest seed/],
    [['--unknown'], /Unknown option '--unknown'/],
    [['positional'], /Unexpected argument 'positional'/],
  ])('rejects %j with a message', (argv, message) => {
    expect(() => parseCliOptions(argv)).toThrow(UsageError);
    expect(() => parseCliOptions(argv)).toThrow(message);
  });
});
