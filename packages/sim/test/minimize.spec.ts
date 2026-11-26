import { minimize } from '../src/minimize';

const failsWhenContains =
  (...needed: number[]) =>
  (candidate: number[]) =>
    Promise.resolve(needed.every((n) => candidate.includes(n)));

describe('minimize', () => {
  const steps = Array.from({ length: 100 }, (_, i) => i);

  it('keeps only the steps that the failure needs', async () => {
    const result = await minimize(steps, failsWhenContains(17, 63), 1_000);
    expect(result.steps).toEqual([17, 63]);
    expect(result.complete).toBe(true);
  });

  it('keeps the order of the remaining steps', async () => {
    const result = await minimize(steps, failsWhenContains(80, 5, 40), 1_000);
    expect(result.steps).toEqual([5, 40, 80]);
  });

  it('reduces to nothing when the failure needs no step', async () => {
    const result = await minimize(steps, () => Promise.resolve(true), 1_000);
    expect(result.steps).toEqual([]);
  });

  it('cuts the tail after the last needed step with the prefix search alone', async () => {
    let replays = 0;
    const result = await minimize(
      steps,
      (candidate) => {
        replays += 1;
        return Promise.resolve(candidate.includes(9));
      },
      7,
    );
    expect(replays).toBe(7);
    expect(result.steps.at(-1)).toBe(9);
    expect(result.steps.length).toBeLessThanOrEqual(10);
    expect(result.complete).toBe(false);
  });

  it('never returns a candidate that did not fail', async () => {
    const tried = new Map<string, boolean>();
    const fails = (candidate: number[]) => {
      const verdict = candidate.includes(3) && candidate.includes(4);
      tried.set(candidate.join(','), verdict);
      return Promise.resolve(verdict);
    };
    for (const budget of [1, 2, 5, 13, 40]) {
      const result = await minimize(steps, fails, budget);
      const key = result.steps.join(',');
      if (result.steps.length < steps.length) expect(tried.get(key)).toBe(true);
    }
  });
});
