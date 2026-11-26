import { PROFILES, type ProfileName } from '@fieldsync/sim';

/**
 * What CI runs on every push: for each profile, the first `runs` scenarios that fast-check generates
 * from one fixed seed, so no scenario is picked for being convenient. Changing a seed, a run count
 * or the budget needs a reason in the README (Simulation section).
 */
export const CORPUS: ReadonlyArray<{ profile: ProfileName; seed: number; runs: number }> = [
  { profile: 'baseline', seed: 1, runs: 40 },
  { profile: 'rejections', seed: 1, runs: 20 },
  { profile: 'multi-site', seed: 1, runs: 20 },
  { profile: 'full', seed: 1, runs: 20 },
];

/** Time fast-check may spend shrinking the first unexpected failure of a profile in CI. */
export const SHRINK_TIME_MS = 60_000;

export { PROFILES };
