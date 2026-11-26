import { createHash } from 'node:crypto';
import { HttpTransport, MemoryStorage, SyncClient, type Row } from '@fieldsync/sync-core';
import { SimClock } from './clock';
import type { LinkState, NetworkEvent, RequestFault, ResponseFault } from './network';
import { SimNetwork } from './network';
import { canonicalJson, compareWithServer, type Divergence } from './oracle';
import type { ActionKind, Profile, Signature, StepKind } from './profiles';
import { Random } from './random';
import { accessibleSites, buildFixtures, generateAction, type Action } from './scenario';
import type { Fixtures, SimServer, SimUser } from './types';

/**
 * One step of a scenario's fault phase. Recording a run produces the list of steps it took; replaying
 * that list (or a part of it, when minimising) reproduces the run without drawing new random choices
 * for these steps. Steps name clients and the oldest request or answer of a client rather than an
 * exchange id, so a step still means something when earlier steps are removed.
 */
export type Step =
  | { kind: 'act'; client: string; intent: ActionKind; action: Action }
  | { kind: 'sync'; client: string }
  | { kind: 'deliver'; client: string; fault: RequestFault }
  | { kind: 'respond'; client: string; fault: ResponseFault }
  | { kind: 'redeliver'; client: string }
  | { kind: 'tick'; ms: number }
  | { kind: 'link'; client: string; state: LinkState };

export type Violation =
  | { signature: 'divergence' | 'foreign-site-rows'; client: string; detail: Divergence }
  | { signature: 'rejected-mutation-500' | 'stuck-request' | 'livelock'; clients: string[]; detail: string }
  | { signature: 'client-error'; detail: string };

export interface RunResult {
  seed: number;
  profile: string;
  /** The fault-phase steps the run took (the replay script). */
  script: Step[];
  violations: Violation[];
  /** True when every queue drained within the heal budget. */
  quiescent: boolean;
  stats: Record<string, number>;
  trace: string[];
  /** SHA-256 of the trace: equal for two runs of the same seed and script. */
  traceHash: string;
}

export interface RunOptions {
  seed: number;
  profile: Profile;
  server: SimServer;
  /** Replays these fault-phase steps instead of choosing new ones. */
  script?: readonly Step[];
}

/** HttpTransport needs an absolute base URL; the simulated network routes every request to the server. */
const BASE_URL = 'http://fieldsync.sim';
/** Virtual time starts here for every run, so timestamps in the trace never depend on the host clock. */
const START = Date.UTC(2030, 0, 1);
/** Macrotask turns without progress after which the clients count as settled. */
const QUIET_TURNS = 3;
const MAX_SETTLE_TURNS = 1_000;

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'act':
      return `act ${step.client} ${step.action.name} ${canonicalJson(step.action.args)}`;
    case 'sync':
    case 'redeliver':
      return `${step.kind} ${step.client}`;
    case 'deliver':
    case 'respond':
      return `${step.kind} ${step.client} fault=${step.fault}`;
    case 'tick':
      return `tick ${step.ms}ms`;
    case 'link':
      return `link ${step.client} ${step.state}`;
  }
}

function describeEvent(event: NetworkEvent): string {
  const id = `${event.client}#${'exchange' in event ? event.exchange : ''}`;
  const answers = (list: { status: number; body: string; errors: string[] }[]) =>
    list.map((a) => `${a.status} body:${digest(a.body)}${a.errors.length ? ` errors:${a.errors.join(',')}` : ''}`);
  switch (event.kind) {
    case 'sent':
      return `  sent ${id} ${event.method} ${event.path}${event.body === undefined ? '' : ` body:${digest(event.body)}`}`;
    case 'delivered':
      return `  delivered ${id} fault=${event.fault} -> ${answers(event.responses).join(' | ') || 'nothing'}`;
    case 'answered':
      return `  answered ${id} fault=${event.fault} status=${event.status}`;
    case 'redelivered':
      return `  redelivered ${id} -> ${answers(event.responses).join(' | ')}`;
    case 'link':
      return `  link ${event.client} ${event.state}`;
  }
}

/** How many mutations a successful push answer reports as rejected. */
function rejectedResults(status: number, body: string): number {
  if (status < 200 || status >= 300) return 0;
  try {
    const parsed = JSON.parse(body) as { results?: Array<{ status?: unknown }> };
    return Array.isArray(parsed.results) ? parsed.results.filter((r) => r.status === 'rejected').length : 0;
  } catch {
    return 0;
  }
}

/** The row a step's action targets, for counting rows that several clients write. */
function targetOf(action: Action): string | undefined {
  const id = action.args.id;
  if (typeof id !== 'string') return undefined;
  return `${action.name.startsWith('part.') ? 'part' : 'ticket'}/${id}`;
}

class Counters {
  readonly values: Record<string, number> = {};

  add(name: string, by = 1): void {
    this.values[name] = (this.values[name] ?? 0) + by;
  }
}

interface SimClient {
  name: string;
  user: SimUser;
  client: SyncClient;
}

/** Runs one seed of a profile against `server` and checks liveness and convergence. */
export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { seed, profile, server } = options;
  const root = new Random(seed);
  const fixtures: Fixtures = buildFixtures(profile, root.fork('fixtures'));
  const clock = new SimClock(START);
  const trace: string[] = [`seed ${seed} profile ${profile.name}`];
  const stats = new Counters();
  const violations: Violation[] = [];
  const script: Step[] = [];
  const pushPaths = new Map<number, boolean>();
  const lastPushErrors = new Map<string, string[]>();
  const lastWriter = new Map<string, string>();

  const onNetwork = (event: NetworkEvent) => {
    trace.push(describeEvent(event));
    switch (event.kind) {
      case 'sent':
        stats.add('exchanges');
        pushPaths.set(event.exchange, event.path.startsWith('/sync/push'));
        break;
      case 'delivered':
      case 'redelivered': {
        if (event.kind === 'delivered') stats.add(`requestFault:${event.fault}`);
        else stats.add('redelivered');
        const errors = event.responses.flatMap((r) => r.errors);
        // A rejection either fails the request (a recorded MutationRejected) or is reported per mutation.
        stats.add('serverRejections', errors.filter((e) => e.startsWith('MutationRejected')).length);
        if (pushPaths.get(event.exchange)) {
          for (const r of event.responses) stats.add('serverRejections', rejectedResults(r.status, r.body));
          if (event.kind === 'delivered') lastPushErrors.set(event.client, errors);
        }
        break;
      }
      case 'answered':
        stats.add(`responseFault:${event.fault}`);
        break;
      case 'link':
        stats.add(`link:${event.state}`);
        break;
    }
  };

  await server.reset(fixtures, () => clock.now());
  const network = new SimNetwork(server, onNetwork);
  const clients: SimClient[] = profile.clients.map((spec, index) => {
    const user = fixtures.users[spec.user];
    if (!user)
      throw new Error(`profile ${profile.name}: client ${index} names user ${spec.user}, which does not exist`);
    const name = `c${index}`;
    const client = new SyncClient({
      clientId: root.fork(`client-id/${index}`).uuid(),
      transport: new HttpTransport(BASE_URL, user.token, network.fetchFor(name)),
      storage: new MemoryStorage(),
      clock: clock.view(spec.skewMs),
    });
    return { name, user, client };
  });
  const byName = new Map(clients.map((c) => [c.name, c]));
  const named = (name: string): SimClient => {
    const found = byName.get(name);
    if (!found) throw new Error(`the scenario names client ${name}, which does not exist`);
    return found;
  };

  const progress = () => trace.length + clients.reduce((sum, c) => sum + c.client.snapshotVersion, 0);
  /** Lets every client run until it waits on the network or a timer again (all its I/O is simulated). */
  const settle = async () => {
    let last = progress();
    let quiet = 0;
    for (let turn = 0; turn < MAX_SETTLE_TURNS; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const now = progress();
      if (now === last) {
        quiet += 1;
        if (quiet >= QUIET_TURNS) return;
      } else {
        quiet = 0;
        last = now;
      }
    }
    throw new Error(`the clients did not settle within ${MAX_SETTLE_TURNS} turns`);
  };

  /** What the user of a client sees and may act on. */
  const actorView = (sim: SimClient) => {
    const sites = accessibleSites(sim.user, fixtures);
    const mine = (row: Row) => typeof row.siteId === 'string' && sites.has(row.siteId);
    return {
      sites: [...sites],
      tickets: guard(() => sim.client.rows('ticket')).filter(mine),
      parts: guard(() => sim.client.rows('part')).filter(mine),
    };
  };

  /** Whether a step can happen now: the request, answer or copy it names exists. */
  const possible = (step: Step): boolean => {
    switch (step.kind) {
      case 'deliver':
        return network.queuedClients().includes(step.client);
      case 'respond':
        return network.answeredClients().includes(step.client);
      case 'redeliver':
        return network.heldClients().includes(step.client);
      case 'act':
      case 'sync':
      case 'tick':
      case 'link':
        return true;
    }
  };

  /** Writes the step to the trace, then executes it if it can happen now (see {@link possible}). */
  const execute = async (label: string, step: Step): Promise<void> => {
    if (!possible(step)) {
      trace.push(`${label} skipped ${describeStep(step)}`);
      return;
    }
    trace.push(`${label} ${describeStep(step)}`);
    switch (step.kind) {
      case 'act': {
        const sim = named(step.client);
        guard(() => sim.client.mutate(step.action.name, step.action.args));
        stats.add(`action:${step.intent}`);
        const target = targetOf(step.action);
        if (target) {
          // A write to a row another client wrote last: the situation merge semantics exist for.
          const previous = lastWriter.get(target);
          if (previous !== undefined && previous !== step.client) stats.add('crossClientWrites');
          lastWriter.set(target, step.client);
        }
        break;
      }
      case 'sync':
        void named(step.client).client.sync();
        break;
      case 'deliver':
        await network.deliver(step.client, step.fault);
        break;
      case 'respond':
        network.respond(step.client, step.fault);
        break;
      case 'redeliver':
        await network.redeliver(step.client);
        break;
      case 'tick':
        stats.add('timersFired', await clock.advance(step.ms, settle));
        break;
      case 'link':
        named(step.client);
        network.setLink(step.client, step.state);
        break;
    }
    await settle();
  };

  const stepRandom = root.fork('steps');
  const actionRandom = root.fork('actions');
  const faultRandom = root.fork('faults');
  const choose = (): Step => {
    const enabled: Record<StepKind, number> = { ...profile.stepWeights };
    if (network.queuedClients().length === 0) enabled.deliver = 0;
    if (network.answeredClients().length === 0) enabled.respond = 0;
    if (network.heldClients().length === 0) enabled.redeliver = 0;
    const kind = stepRandom.weighted(enabled);
    switch (kind) {
      case 'act': {
        const sim = stepRandom.pick(clients);
        const intent = actionRandom.weighted(profile.actionWeights);
        const action = generateAction(intent, actorView(sim), actionRandom, profile.invalidText);
        return { kind, client: sim.name, intent, action };
      }
      case 'sync':
        return { kind, client: stepRandom.pick(clients).name };
      case 'deliver':
        return {
          kind,
          client: stepRandom.pick(network.queuedClients()),
          fault: faultRandom.weighted(profile.requestFaults),
        };
      case 'respond':
        return {
          kind,
          client: stepRandom.pick(network.answeredClients()),
          fault: faultRandom.weighted(profile.responseFaults),
        };
      case 'redeliver':
        return { kind, client: stepRandom.pick(network.heldClients()) };
      case 'tick':
        return { kind, ms: stepRandom.int(100, profile.maxTickMs) };
      case 'link':
        return { kind, client: stepRandom.pick(clients).name, state: faultRandom.weighted(profile.linkStates) };
    }
  };

  let quiescent = false;
  try {
    // Every client opens the app: an initial sync, as the web app does on start.
    trace.push('open');
    for (const sim of clients) void sim.client.sync();
    await settle();

    // Fault phase.
    const steps = options.script ?? [];
    const count = options.script ? steps.length : profile.steps;
    for (let index = 0; index < count; index += 1) {
      const step = options.script ? (steps[index] as Step) : choose();
      script.push(step);
      await execute(`#${index}`, step);
    }

    // Heal: the network recovers and stops failing; every queue must drain within the budget.
    trace.push('heal');
    for (const sim of clients) network.setLink(sim.name, 'up');
    const healRandom = root.fork('heal');
    let finalRound = false;
    const busy = () => clients.filter((c) => c.client.pendingCount > 0 || c.client.status !== 'idle');
    for (let step = 0; step < profile.healSteps; step += 1) {
      const options: Step[] = [
        ...network.queuedClients().map((client): Step => ({ kind: 'deliver', client, fault: 'none' })),
        ...network.answeredClients().map((client): Step => ({ kind: 'respond', client, fault: 'none' })),
        ...network.heldClients().map((client): Step => ({ kind: 'redeliver', client })),
      ];
      if (options.length > 0) {
        await execute('heal', healRandom.pick(options));
        continue;
      }
      if (busy().length > 0) {
        // Nothing in transit: let the next retry timer fire. With no timer set the busy clients are stuck.
        const moved = await clock.advanceToNext(settle);
        if (moved === undefined) break;
        trace.push(`heal next timer +${moved}ms`);
        stats.add('timersFired');
        continue;
      }
      if (!finalRound) {
        // Everything is quiet: one more sync per client picks up what the others wrote last.
        finalRound = true;
        trace.push('final sync');
        for (const sim of clients) void sim.client.sync();
        await settle();
        continue;
      }
      quiescent = true;
      break;
    }

    if (!quiescent) {
      const stuck = busy();
      const bySignature = new Map<Signature, string[]>();
      for (const sim of stuck) {
        const errors = lastPushErrors.get(sim.name) ?? [];
        const signature: Signature = network.hungClients().includes(sim.name)
          ? 'stuck-request'
          : errors.some((e) => e.startsWith('MutationRejected'))
            ? 'rejected-mutation-500'
            : 'livelock';
        bySignature.set(signature, [...(bySignature.get(signature) ?? []), sim.name]);
      }
      if (stuck.length === 0) bySignature.set('livelock', []);
      for (const [signature, names] of bySignature) {
        const detail = names
          .map((n) => {
            const c = named(n).client;
            return `${n}: status=${c.status} pending=${c.pendingCount} last push errors=[${(lastPushErrors.get(n) ?? []).join(',')}]`;
          })
          .join('; ');
        violations.push({
          signature: signature as 'rejected-mutation-500' | 'stuck-request' | 'livelock',
          clients: names,
          detail: detail || `the heal budget of ${profile.healSteps} steps ran out`,
        });
      }
    } else {
      const rows = await server.liveRows();
      for (const sim of clients) {
        const view = guard(() => sim.client.view());
        const divergence = compareWithServer(rows, accessibleSites(sim.user, fixtures), view);
        if (!divergence) continue;
        violations.push({
          signature: divergence.foreign.length > 0 ? 'foreign-site-rows' : 'divergence',
          client: sim.name,
          detail: divergence,
        });
      }
    }
  } catch (err) {
    // An exception from the client code (for example while computing its view) is a finding;
    // one from the harness or the server binding propagates instead.
    if (!(err instanceof ClientError)) throw err;
    violations.push({ signature: 'client-error', detail: err.message });
  } finally {
    for (const sim of clients) sim.client.dispose();
  }

  for (const sim of clients) {
    let state: Map<string, Row>;
    try {
      state = sim.client.view();
    } catch {
      state = new Map();
    }
    const view = [...state].map(([k, v]) => `${k}=${canonicalJson(v)}`).sort();
    trace.push(
      `final ${sim.name} status=${sim.client.status} pending=${sim.client.pendingCount} rows=${view.length} digest:${digest(view.join('\n'))}`,
    );
  }
  stats.add('steps', script.length);
  return {
    seed,
    profile: profile.name,
    script,
    violations,
    quiescent,
    stats: stats.values,
    trace,
    traceHash: createHash('sha256').update(trace.join('\n')).digest('hex'),
  };
}

/** An exception thrown by the client code under test, as opposed to one from the harness. */
export class ClientError extends Error {
  constructor(cause: unknown) {
    super(`the client threw: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`, {
      cause,
    });
    this.name = 'ClientError';
  }
}

/** Runs client code; anything it throws becomes a {@link ClientError}. */
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    throw new ClientError(err);
  }
}
