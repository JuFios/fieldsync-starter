import fc from 'fast-check';
import { commandsArb } from './arbitraries';
import type { Profile } from './profiles';
import {
  simulationProperty,
  SimulationFailure,
  SimulationInterrupted,
  type RunResult,
  type SimCommand,
  type Violation,
} from './simulation';
import type { SimServer } from './types';

export interface CheckOptions {
  profile: Profile;
  server: SimServer;
  /** fast-check seed of the search. */
  seed: number;
  /** Runs (generated scenarios) to try. */
  runs: number;
  /** fast-check path of one run to replay (`--path` printed by a failure) instead of searching. */
  path?: string;
  /** fast-check's replay hint for the commands of that run (`replayPath`). */
  replayPath?: string;
  /**
   * Time the shrinker may spend on a failure, in ms. 0 reports the failure as found. Shrinking
   * resumes from the failure's seed and path, and fast-check skips what is left of it after the
   * time limit (`skipAllAfterTimeLimit`), reporting the smallest failing scenario found so far.
   */
  shrinkTimeMs: number;
  /** Called with every run of the search, in order: the run at index i is replayed with path `i`. */
  onRun?(result: RunResult, index: number): void;
  /** Stops the search (or the shrinking) before the next run; the report then says `interrupted`. */
  signal?: AbortSignal;
}

export interface Failure {
  seed: number;
  /** fast-check path of the failing scenario: with `seed`, replays exactly that scenario. */
  path: string;
  replayPath?: string;
  /** The run of the reported scenario (the shrunk one when shrinking ran). */
  result: RunResult;
  unexpected: readonly Violation[];
  /** Steps of the scenario as the search found it, before shrinking. */
  foundSteps: number;
  /** Successful shrinks; 0 when shrinking did not run or found nothing smaller. */
  shrinks: number;
  /** False when the time limit stopped shrinking before fast-check finished. */
  shrinkComplete: boolean;
}

export interface CheckReport {
  seed: number;
  /** The runs of the search, in fast-check's order. */
  results: RunResult[];
  failure?: Failure;
  /** True when the abort signal stopped the search or the shrinking. */
  interrupted?: boolean;
}

function failureOf(details: fc.RunDetails<[Iterable<SimCommand>]>): SimulationFailure {
  if (details.errorInstance instanceof SimulationFailure) return details.errorInstance;
  // Not a finding: the harness or the server binding broke. Surface the original error.
  if (details.errorInstance instanceof Error) throw details.errorInstance;
  throw new Error(`the simulation stopped without a result: ${String(details.errorInstance)}`);
}

/** fast-check prints `/*replayPath="…"*\/` after the commands of a failing scenario. */
function replayPathOf(details: fc.RunDetails<[Iterable<SimCommand>]>): string | undefined {
  const printed = details.counterexample ? fc.stringify(details.counterexample[0]) : '';
  return /replayPath="([^"]*)"/.exec(printed)?.[1];
}

/**
 * Checks a profile's property over `runs` generated scenarios (fast-check `check`), stopping at the
 * first unexpected violation, then shrinks it within the time limit. The search itself never
 * shrinks (`endOnFailure`), so every call of `onRun` is one generated scenario.
 */
export async function checkProfile(options: CheckOptions): Promise<CheckReport> {
  const { profile, server, seed } = options;
  const results: RunResult[] = [];
  const search = await fc.check(
    simulationProperty(
      profile,
      server,
      commandsArb(profile, options.replayPath),
      (result) => {
        results.push(result);
        options.onRun?.(result, results.length - 1);
      },
      options.signal,
    ),
    { seed, numRuns: options.runs, path: options.path, endOnFailure: true },
  );
  if (!search.failed) return { seed, results };
  if (search.errorInstance instanceof SimulationInterrupted) return { seed, results, interrupted: true };

  const found = failureOf(search);
  const path = search.counterexamplePath ?? options.path ?? '0';
  const unshrunk: Failure = {
    seed,
    path,
    replayPath: replayPathOf(search),
    result: found.result,
    unexpected: found.unexpected,
    foundSteps: found.result.script.length,
    shrinks: 0,
    shrinkComplete: false,
  };
  if (options.shrinkTimeMs <= 0) return { seed, results, failure: unshrunk };

  const shrink = await fc.check(simulationProperty(profile, server, commandsArb(profile), undefined, options.signal), {
    seed,
    path,
    skipAllAfterTimeLimit: options.shrinkTimeMs,
  });
  if (!shrink.failed) {
    // The replay passed: the failure depends on something outside the scenario (it is not reproducible).
    throw new Error(`profile ${profile.name}: seed ${seed} path ${path} failed once but passed on replay`);
  }
  // Interrupted while shrinking: report the failure as found.
  if (shrink.errorInstance instanceof SimulationInterrupted)
    return { seed, results, failure: unshrunk, interrupted: true };
  const smallest = failureOf(shrink);
  return {
    seed,
    results,
    failure: {
      ...unshrunk,
      path: shrink.counterexamplePath ?? path,
      replayPath: replayPathOf(shrink),
      result: smallest.result,
      unexpected: smallest.unexpected,
      shrinks: shrink.numShrinks,
      shrinkComplete: shrink.numSkips === 0,
    },
  };
}
