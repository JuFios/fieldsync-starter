import { minimize } from './minimize';
import { KNOWN_SIGNATURES, type Profile, type Signature } from './profiles';
import { describeStep, runScenario, type RunResult, type Step, type Violation } from './simulation';
import type { SimServer } from './types';

export interface MinimizedRun {
  result: RunResult;
  /** Replays the minimiser used. */
  replays: number;
  /** False when the replay budget ran out before the scenario was 1-minimal. */
  complete: boolean;
}

/**
 * Shrinks the fault phase of a failing run to fewer steps that still produce `signature`, by
 * replaying candidate scripts against the same server. Returns the replay of the smallest script.
 */
export async function minimizeRun(
  failing: RunResult,
  signature: Signature,
  profile: Profile,
  server: SimServer,
  maxReplays: number,
): Promise<MinimizedRun> {
  const fails = async (script: Step[]) => {
    const replay = await runScenario({ seed: failing.seed, profile, server, script });
    return replay.violations.some((v) => v.signature === signature);
  };
  const { steps, replays, complete } = await minimize(failing.script, fails, maxReplays);
  const result = await runScenario({ seed: failing.seed, profile, server, script: steps });
  return { result, replays, complete };
}

function describeViolation(v: Violation): string {
  const known = KNOWN_SIGNATURES[v.signature];
  const label = known ? `${v.signature} (known defect ${known.defect} -> ${known.owner})` : v.signature;
  switch (v.signature) {
    case 'divergence':
    case 'foreign-site-rows': {
      const d = v.detail;
      const list = (name: string, keys: string[]) =>
        keys.length ? ` ${name}=${keys.slice(0, 5).join(',')}${keys.length > 5 ? `,+${keys.length - 5}` : ''}` : '';
      return `${label} at ${v.client}:${list('missing', d.missing)}${list('unexpected', d.unexpected)}${list('foreign', d.foreign)}${list('different', d.different)}`;
    }
    case 'rejected-mutation-500':
    case 'stuck-request':
    case 'livelock':
      return `${label}: ${v.detail}`;
    case 'client-error':
      return `${label}: ${v.detail}`;
  }
}

/** A readable account of a failing run: what broke, how to replay it, and the minimised scenario. */
export function formatFailure(failing: RunResult, minimized?: MinimizedRun, traceLines = 60): string {
  const lines = [
    `Simulation failed: profile ${failing.profile}, seed ${failing.seed} (trace ${failing.traceHash.slice(0, 16)})`,
    ...failing.violations.map((v) => `  - ${describeViolation(v)}`),
    `Replay: npm run sim -- --profile ${failing.profile} --seed ${failing.seed} --trace`,
  ];
  if (minimized) {
    const steps = minimized.result.script;
    lines.push(
      `Minimised to ${steps.length} of ${failing.script.length} steps in ${minimized.replays} replays` +
        `${minimized.complete ? '' : ' (replay budget exhausted)'}:`,
      ...steps.map((s, i) => `  ${i}. ${describeStep(s)}`),
      `Minimised run: ${minimized.result.violations.map((v) => v.signature).join(', ') || 'no violation'}`,
      `Last ${traceLines} trace lines of the minimised run:`,
      ...minimized.result.trace.slice(-traceLines).map((l) => `  ${l}`),
    );
  } else {
    lines.push(`Last ${traceLines} trace lines:`, ...failing.trace.slice(-traceLines).map((l) => `  ${l}`));
  }
  return lines.join('\n');
}
