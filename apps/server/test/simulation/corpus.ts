import { PROFILES, type ProfileName } from '@fieldsync/sim';

/**
 * The seeds CI runs on every push. Each profile runs a contiguous range starting at 1, so no seed
 * is picked for being convenient; changing a range or the budget needs a reason in the README
 * (Simulation section).
 */
export const CORPUS: ReadonlyArray<{ profile: ProfileName; seeds: number }> = [
  { profile: 'baseline', seeds: 40 },
  { profile: 'rejections', seeds: 12 },
  { profile: 'multi-site', seeds: 12 },
  { profile: 'full', seeds: 12 },
];

/** Replays the minimiser may spend on the first unexpected failure of a profile. */
export const MINIMIZE_REPLAYS = 60;

export function seedRange(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

export { PROFILES };
