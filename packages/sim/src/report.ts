import type { Failure } from './check';
import { KNOWN_SIGNATURES } from './profiles';
import type { Violation } from './simulation';

export function describeViolation(v: Violation): string {
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
    case 'unexpected-rejection':
    case 'stuck-request':
    case 'livelock':
    case 'client-error':
      return `${label}: ${v.detail}`;
    case 'lost-edit':
      return `${label}: ${v.detail.slice(0, 5).join('; ')}${v.detail.length > 5 ? `; +${v.detail.length - 5}` : ''}`;
  }
}

/** The command that replays a scenario: its fast-check seed and path (and replay hint). */
export function replayCommand(profile: string, failure: Pick<Failure, 'seed' | 'path' | 'replayPath'>): string {
  const hint = failure.replayPath ? ` --replay-path '${failure.replayPath}'` : '';
  return `npm run sim -- --profile ${profile} --seed ${failure.seed} --path ${failure.path}${hint} --trace`;
}

/** A readable account of a failure: what broke, how to replay it, the steps and the end of the trace. */
export function formatFailure(failure: Failure, traceLines = 60): string {
  const { result } = failure;
  const shrunk =
    failure.shrinks > 0
      ? `shrunk from ${failure.foundSteps} to ${result.script.length} steps in ${failure.shrinks} shrinks` +
        `${failure.shrinkComplete ? '' : ' (time limit reached)'}`
      : `${result.script.length} steps, not shrunk`;
  return [
    `Simulation failed: profile ${result.profile}, seed ${failure.seed}, path ${failure.path} (trace ${result.traceHash.slice(0, 16)})`,
    ...failure.unexpected.map((v) => `  - ${describeViolation(v)}`),
    `Replay: ${replayCommand(result.profile, failure)}`,
    `Scenario (${shrunk}):`,
    ...result.script.map((s, i) => `  ${i}. ${s}`),
    `Last ${traceLines} trace lines:`,
    ...result.trace.slice(-traceLines).map((l) => `  ${l}`),
  ].join('\n');
}
