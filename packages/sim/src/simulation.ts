import { createHash } from 'node:crypto';
import { HttpTransport, MemoryStorage, SyncClient, type Row } from '@fieldsync/sync-core';
import fc from 'fast-check';
import { SimClock } from './clock';
import type { LinkState, NetworkEvent, RequestFault, ResponseFault } from './network';
import { SimNetwork } from './network';
import {
  canonicalJson,
  compareWithServer,
  lostEdits,
  ticketFieldWrite,
  type Divergence,
  type TicketFieldWrite,
} from './oracle';
import type { ActionKind, Profile, Signature } from './profiles';
import { accessibleSites, buildFixtures, generateAction, simUuid, type Action, type ActionParams } from './scenario';
import type { Fixtures, SimServer, SimUser } from './types';

/**
 * One step of a run's fault phase: what a fast-check command does. Steps name a client by index
 * and pick among the clients that have a request, answer or copy waiting (modulo their number), so a
 * step still means something when the shrinker removes earlier steps. A step that cannot happen
 * when it runs (nothing waiting) is traced as skipped.
 */
export type Step =
  | { kind: 'act'; client: number; intent: ActionKind; params: ActionParams }
  | { kind: 'sync'; client: number }
  | { kind: 'deliver'; pick: number; fault: RequestFault }
  | { kind: 'respond'; pick: number; fault: ResponseFault }
  | { kind: 'redeliver'; pick: number }
  | { kind: 'tick'; ms: number }
  | { kind: 'link'; client: number; state: LinkState }
  /** The server runs its change-log GC at the current virtual time. */
  | { kind: 'compact' }
  /** A client loses its link and is away for the profile's `awayMs` (longer than the retention). */
  | { kind: 'away'; client: number };

export type Violation =
  | { signature: 'divergence' | 'foreign-site-rows'; client: string; detail: Divergence }
  | { signature: 'rejected-mutation-500' | 'stuck-request' | 'livelock'; clients: string[]; detail: string }
  | { signature: 'client-error'; detail: string }
  | { signature: 'unexpected-rejection'; clients: string[]; detail: string }
  | { signature: 'lost-edit'; detail: string[] }
  | { signature: 'lost-mutation'; clients: string[]; detail: string };

export interface RunResult {
  profile: string;
  /** The fault-phase steps the run executed, as fast-check printed them. */
  script: string[];
  violations: Violation[];
  /** True when every queue drained within the heal budget. */
  quiescent: boolean;
  stats: Record<string, number>;
  trace: string[];
  /** SHA-256 of the trace: equal for two runs of the same commands. */
  traceHash: string;
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
      return `act c${step.client} ${step.intent}`;
    case 'sync':
      return `sync c${step.client}`;
    case 'deliver':
    case 'respond':
      return `${step.kind} #${step.pick} fault=${step.fault}`;
    case 'redeliver':
      return `redeliver #${step.pick}`;
    case 'tick':
      return `tick ${step.ms}ms`;
    case 'link':
      return `link c${step.client} ${step.state}`;
    case 'compact':
      return 'compact';
    case 'away':
      return `away c${step.client}`;
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

/** The rejection codes of the mutations a successful push answer reports as rejected. */
function rejectedCodes(status: number, body: string): string[] {
  if (status < 200 || status >= 300) return [];
  try {
    const parsed = JSON.parse(body) as { results?: Array<{ status?: unknown; code?: unknown }> };
    if (!Array.isArray(parsed.results)) return [];
    return parsed.results.filter((r) => r.status === 'rejected').map((r) => String(r.code));
  } catch {
    return [];
  }
}

/** The mutations a push request carries, by id, and the client that sent them. */
interface SentPush {
  clientId: string;
  mutations: Map<number, { name: string; args: Record<string, unknown> }>;
}

function sentPush(body: string | undefined): SentPush | undefined {
  try {
    const parsed = JSON.parse(body ?? '') as {
      clientId?: unknown;
      mutations?: Array<{ id?: unknown; name?: unknown; args?: unknown }>;
    };
    if (typeof parsed.clientId !== 'string' || !Array.isArray(parsed.mutations)) return undefined;
    const mutations = new Map<number, { name: string; args: Record<string, unknown> }>();
    for (const m of parsed.mutations) {
      if (typeof m.id === 'number' && typeof m.name === 'string' && typeof m.args === 'object' && m.args !== null) {
        mutations.set(m.id, { name: m.name, args: m.args as Record<string, unknown> });
      }
    }
    return { clientId: parsed.clientId, mutations };
  } catch {
    return undefined;
  }
}

/** The id and status of every mutation a successful push answer reports. */
function pushResults(status: number, body: string): Array<{ id: number; status: string }> {
  if (status < 200 || status >= 300) return [];
  try {
    const parsed = JSON.parse(body) as { results?: Array<{ id?: unknown; status?: unknown }> };
    if (!Array.isArray(parsed.results)) return [];
    return parsed.results.flatMap((r) =>
      typeof r.id === 'number' && typeof r.status === 'string' ? [{ id: r.id, status: r.status }] : [],
    );
  } catch {
    return [];
  }
}

/** The row an action targets, for counting rows that several clients write. */
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

/**
 * The violations a client's divergence from the server's rows shows: `foreign-site-rows` for rows of
 * sites its user cannot access, and separately `divergence` for anything else (rows of its own sites
 * missing, different or kept after the server deleted them), so a tolerated leak of foreign rows
 * never hides a lost or wrong row.
 */
export function convergenceViolations(client: string, divergence: Divergence): Violation[] {
  const violations: Violation[] = [];
  const foreign = new Set(divergence.foreign);
  if (foreign.size > 0) {
    violations.push({
      signature: 'foreign-site-rows',
      client,
      detail: { missing: [], unexpected: [...divergence.foreign], foreign: [...divergence.foreign], different: [] },
    });
  }
  const own: Divergence = {
    missing: divergence.missing,
    unexpected: divergence.unexpected.filter((key) => !foreign.has(key)),
    foreign: [],
    different: divergence.different,
  };
  if (own.missing.length + own.unexpected.length + own.different.length > 0) {
    violations.push({ signature: 'divergence', client, detail: own });
  }
  return violations;
}

/**
 * The real system of the model-based test: the profile's clients (the production `SyncClient` with
 * `HttpTransport`, `MemoryStorage` and a view of the virtual clock), the simulated network between
 * them and the server, and what the run records (trace and statistics).
 */
export class SimSystem {
  readonly trace: string[];
  readonly stats = new Counters();
  readonly script: string[] = [];
  private readonly clients: SimClient[];
  private readonly network: SimNetwork;
  private readonly clock = new SimClock(START);
  private readonly pushPaths = new Map<number, boolean>();
  /** The push requests sent, by exchange, to know what an answer's mutation ids stand for. */
  private readonly sentPushes = new Map<number, SentPush>();
  /** Writes to ticket text fields, in the order the server applied them (it handles one request at a time). */
  private readonly fieldWrites: TicketFieldWrite[] = [];
  /** `clientId/mutationId` of every mutation answered as applied or duplicate. */
  private readonly answered = new Set<string>();
  /** Tickets written by a mutation whose first answer was lost, so its place in the order is unknown. */
  private readonly unorderedTickets = new Set<string>();
  private readonly lastPushErrors = new Map<string, string[]>();
  /** Every rejection with a code the profile does not expect. */
  private readonly unexpectedRejections: Array<{ client: string; code: string }> = [];
  private readonly lastWriter = new Map<string, string>();
  /** Mutations each client queued (its `mutate` calls that returned): the server must handle every one. */
  private readonly queued = new Map<string, number>();
  private ids = 0;
  private steps = 0;

  private constructor(
    readonly profile: Profile,
    private readonly server: SimServer,
    private readonly fixtures: Fixtures,
  ) {
    this.trace = [`profile ${profile.name}`];
    this.network = new SimNetwork(server, (event) => this.onNetwork(event));
    this.clients = profile.clients.map((spec, index) => {
      const user = fixtures.users[spec.user];
      if (!user) {
        throw new Error(`profile ${profile.name}: client ${index} names user ${spec.user}, which does not exist`);
      }
      const name = `c${index}`;
      const client = new SyncClient({
        clientId: simUuid(3, index + 1),
        transport: new HttpTransport(BASE_URL, user.token, this.network.fetchFor(name)),
        storage: new MemoryStorage(),
        clock: this.clock.view(spec.skewMs),
      });
      return { name, user, client };
    });
  }

  /** Empties the server, writes the fixtures and opens the app on every client (an initial sync). */
  static async start(profile: Profile, server: SimServer): Promise<SimSystem> {
    const fixtures = buildFixtures(profile);
    const system = new SimSystem(profile, server, fixtures);
    await server.reset(fixtures, () => system.clock.now());
    system.trace.push('open');
    for (const sim of system.clients) void sim.client.sync();
    await system.settle();
    return system;
  }

  /** Writes the step to the trace, then executes it if it can happen now. */
  async execute(step: Step): Promise<void> {
    const label = `#${this.steps}`;
    this.steps += 1;
    this.script.push(describeStep(step));
    switch (step.kind) {
      case 'act': {
        const sim = this.client(step.client);
        const action = generateAction(step.intent, this.actorView(sim), step.params, () => {
          this.ids += 1;
          return simUuid(4, this.ids);
        });
        this.trace.push(`${label} act ${sim.name} ${action.name} ${canonicalJson(action.args)}`);
        guard(() => sim.client.mutate(action.name, action.args));
        this.queued.set(sim.name, (this.queued.get(sim.name) ?? 0) + 1);
        this.stats.add(`action:${step.intent}`);
        const target = targetOf(action);
        if (target) {
          // A write to a row another client wrote last: the situation merge semantics exist for.
          const previous = this.lastWriter.get(target);
          if (previous !== undefined && previous !== sim.name) this.stats.add('crossClientWrites');
          this.lastWriter.set(target, sim.name);
        }
        break;
      }
      case 'sync': {
        const sim = this.client(step.client);
        this.trace.push(`${label} sync ${sim.name}`);
        void sim.client.sync();
        break;
      }
      case 'deliver': {
        const waiting = this.network.queuedClients();
        if (!this.traceOrSkip(label, step, waiting)) return;
        const client = waiting[step.pick % waiting.length] as string;
        this.trace.push(`${label} deliver ${client} fault=${step.fault}`);
        await this.network.deliver(client, step.fault);
        break;
      }
      case 'respond': {
        const waiting = this.network.answeredClients();
        if (!this.traceOrSkip(label, step, waiting)) return;
        const client = waiting[step.pick % waiting.length] as string;
        this.trace.push(`${label} respond ${client} fault=${step.fault}`);
        this.network.respond(client, step.fault);
        break;
      }
      case 'redeliver': {
        const waiting = this.network.heldClients();
        if (!this.traceOrSkip(label, step, waiting)) return;
        const client = waiting[step.pick % waiting.length] as string;
        this.trace.push(`${label} redeliver ${client}`);
        await this.network.redeliver(client);
        break;
      }
      case 'tick':
        this.trace.push(`${label} tick ${step.ms}ms`);
        this.stats.add('timersFired', await this.clock.advance(step.ms, () => this.settle()));
        break;
      case 'link': {
        const sim = this.client(step.client);
        this.trace.push(`${label} link ${sim.name} ${step.state}`);
        this.network.setLink(sim.name, step.state);
        break;
      }
      case 'compact': {
        const removed = await this.server.compact();
        this.trace.push(`${label} compact removed=${removed}`);
        this.stats.add('compactions');
        this.stats.add('compactedEntries', removed);
        break;
      }
      case 'away': {
        // The client is cut off, then time passes without anything happening: its retry timers keep
        // their places relative to the new time. It comes back with a later link step or the heal.
        const sim = this.client(step.client);
        this.trace.push(`${label} away ${sim.name} ${this.profile.awayMs}ms`);
        this.network.setLink(sim.name, 'down');
        await this.clock.jump(this.profile.awayMs, () => this.settle());
        this.stats.add('away');
        break;
      }
    }
    await this.settle();
  }

  /**
   * Heal: the network recovers and stops failing; every queue must drain within the profile's heal
   * budget, oldest waiting exchange first. Returns whether the clients became quiescent.
   */
  async heal(): Promise<boolean> {
    this.trace.push('heal');
    for (const sim of this.clients) this.network.setLink(sim.name, 'up');
    let finalRound = false;
    for (let step = 0; step < this.profile.healSteps; step += 1) {
      const queued = this.network.queuedClients()[0];
      if (queued !== undefined) {
        this.trace.push(`heal deliver ${queued}`);
        await this.network.deliver(queued, 'none');
        await this.settle();
        continue;
      }
      const answered = this.network.answeredClients()[0];
      if (answered !== undefined) {
        this.trace.push(`heal respond ${answered}`);
        this.network.respond(answered, 'none');
        await this.settle();
        continue;
      }
      const held = this.network.heldClients()[0];
      if (held !== undefined) {
        this.trace.push(`heal redeliver ${held}`);
        await this.network.redeliver(held);
        await this.settle();
        continue;
      }
      if (this.busy().length > 0) {
        // Nothing in transit: let the next retry timer fire. With no timer set the busy clients are stuck.
        const moved = await this.clock.advanceToNext(() => this.settle());
        if (moved === undefined) break;
        this.trace.push(`heal next timer +${moved}ms`);
        this.stats.add('timersFired');
        continue;
      }
      if (!finalRound) {
        // Everything is quiet: one more sync per client picks up what the others wrote last.
        finalRound = true;
        this.trace.push('final sync');
        for (const sim of this.clients) void sim.client.sync();
        await this.settle();
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Liveness, then convergence with the server's tables. When some clients never drained, the others
   * are still checked: a client stuck on a tolerated known defect must not hide a lost row elsewhere.
   */
  async verdict(quiescent: boolean): Promise<Violation[]> {
    const violations: Violation[] = [];
    let checked = this.clients;
    if (!quiescent) {
      const stuck = this.busy();
      const bySignature = new Map<Signature, string[]>();
      for (const sim of stuck) {
        const errors = this.lastPushErrors.get(sim.name) ?? [];
        const signature: Signature = this.network.hungClients().includes(sim.name)
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
            const c = this.byName(n).client;
            return `${n}: status=${c.status} pending=${c.pendingCount} last push errors=[${(this.lastPushErrors.get(n) ?? []).join(',')}]`;
          })
          .join('; ');
        violations.push({
          signature: signature as 'rejected-mutation-500' | 'stuck-request' | 'livelock',
          clients: names,
          detail: detail || `the heal budget of ${this.profile.healSteps} steps ran out`,
        });
      }
      const drained = this.clients.filter((c) => !stuck.includes(c));
      await this.catchUp(drained);
      const behind = this.busy().filter((c) => drained.includes(c));
      if (behind.length > 0) {
        violations.push({
          signature: 'livelock',
          clients: behind.map((c) => c.name),
          detail: `did not finish catching up within ${this.profile.healSteps} steps`,
        });
      }
      checked = drained.filter((c) => !behind.includes(c));
    }
    if (this.unexpectedRejections.length > 0) {
      violations.push({
        signature: 'unexpected-rejection',
        clients: [...new Set(this.unexpectedRejections.map((r) => r.client))],
        detail: this.unexpectedRejections.map((r) => `${r.client}: ${r.code}`).join(', '),
      });
    }
    const handled = await this.server.handledMutations();
    const lostMutations = checked.flatMap((sim) => {
      const queued = this.queued.get(sim.name) ?? 0;
      const last = handled.get(sim.client.clientId) ?? 0;
      return queued === last && sim.client.pendingCount === 0
        ? []
        : [`${sim.name}: queued ${queued}, server handled up to ${last}`];
    });
    if (lostMutations.length > 0) {
      violations.push({
        signature: 'lost-mutation',
        clients: lostMutations.map((d) => d.split(':')[0] as string),
        detail: lostMutations.join('; '),
      });
    }
    const rows = await this.server.liveRows();
    const lost = lostEdits(rows, this.fieldWrites, this.unorderedTickets);
    if (lost.length > 0) violations.push({ signature: 'lost-edit', detail: lost });
    for (const sim of checked) {
      const view = guard(() => sim.client.view());
      const divergence = compareWithServer(rows, accessibleSites(sim.user, this.fixtures), view);
      if (divergence) violations.push(...convergenceViolations(sim.name, divergence));
    }
    return violations;
  }

  /**
   * Brings clients that drained up to date when others did not, so that their convergence can be
   * checked: each syncs once more and only their own exchanges are delivered and answered, so the
   * stuck clients' requests never reach the server and its rows stay as they are.
   */
  private async catchUp(drained: readonly SimClient[]): Promise<void> {
    if (drained.length === 0) return;
    const names = new Set(drained.map((c) => c.name));
    this.trace.push(`catch up ${[...names].join(',')}`);
    for (const sim of drained) void sim.client.sync();
    await this.settle();
    for (let step = 0; step < this.profile.healSteps; step += 1) {
      const queued = this.network.queuedClients().find((n) => names.has(n));
      if (queued !== undefined) {
        this.trace.push(`catch up deliver ${queued}`);
        await this.network.deliver(queued, 'none');
        await this.settle();
        continue;
      }
      const answered = this.network.answeredClients().find((n) => names.has(n));
      if (answered === undefined) return;
      this.trace.push(`catch up respond ${answered}`);
      this.network.respond(answered, 'none');
      await this.settle();
    }
  }

  /** Stops every client and writes its final state to the trace. */
  dispose(): void {
    for (const sim of this.clients) sim.client.dispose();
    for (const sim of this.clients) {
      let state: Map<string, Row>;
      try {
        state = sim.client.view();
      } catch {
        state = new Map();
      }
      const view = [...state].map(([k, v]) => `${k}=${canonicalJson(v)}`).sort();
      this.trace.push(
        `final ${sim.name} status=${sim.client.status} pending=${sim.client.pendingCount} rows=${view.length} digest:${digest(view.join('\n'))}`,
      );
    }
  }

  private traceOrSkip(label: string, step: Step, waiting: readonly string[]): boolean {
    if (waiting.length > 0) return true;
    this.trace.push(`${label} skipped ${describeStep(step)}`);
    return false;
  }

  private client(index: number): SimClient {
    const found = this.clients[index];
    if (!found) throw new Error(`the scenario names client ${index}, which does not exist`);
    return found;
  }

  private byName(name: string): SimClient {
    const found = this.clients.find((c) => c.name === name);
    if (!found) throw new Error(`no client named ${name}`);
    return found;
  }

  private busy(): SimClient[] {
    return this.clients.filter((c) => c.client.pendingCount > 0 || c.client.status !== 'idle');
  }

  /** What the user of a client sees and may act on. */
  private actorView(sim: SimClient) {
    const sites = accessibleSites(sim.user, this.fixtures);
    const mine = (row: Row) => typeof row.siteId === 'string' && sites.has(row.siteId);
    return {
      sites: [...sites],
      tickets: guard(() => sim.client.rows('ticket')).filter(mine),
      parts: guard(() => sim.client.rows('part')).filter(mine),
    };
  }

  private progress(): number {
    return this.trace.length + this.clients.reduce((sum, c) => sum + c.client.snapshotVersion, 0);
  }

  /** Lets every client run until it waits on the network or a timer again (all its I/O is simulated). */
  private async settle(): Promise<void> {
    let last = this.progress();
    let quiet = 0;
    for (let turn = 0; turn < MAX_SETTLE_TURNS; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const now = this.progress();
      if (now === last) {
        quiet += 1;
        if (quiet >= QUIET_TURNS) return;
      } else {
        quiet = 0;
        last = now;
      }
    }
    throw new Error(`the clients did not settle within ${MAX_SETTLE_TURNS} turns`);
  }

  /**
   * Records what the applied mutations of one push answer wrote into ticket text fields. A mutation
   * whose first answer is `duplicate` was applied by a request whose answer was lost, at a place in
   * the order that is unknown, so the tickets it writes are left out of the lost-edit check.
   */
  private recordApplied(sent: SentPush, results: ReadonlyArray<{ id: number; status: string }>): void {
    for (const r of results) {
      if (r.status !== 'applied' && r.status !== 'duplicate') continue;
      const key = `${sent.clientId}/${r.id}`;
      if (this.answered.has(key)) continue;
      this.answered.add(key);
      const m = sent.mutations.get(r.id);
      const write = m && ticketFieldWrite(m.name, m.args);
      if (!write) continue;
      if (r.status === 'applied') this.fieldWrites.push(write);
      else this.unorderedTickets.add(write.ticket);
    }
  }

  private onNetwork(event: NetworkEvent): void {
    this.trace.push(describeEvent(event));
    switch (event.kind) {
      case 'sent':
        this.stats.add('exchanges');
        // A snapshot starts with a page without a watermark: a new client, or one that was reset.
        if (event.path.startsWith('/sync/snapshot') && !event.path.includes('watermark=')) this.stats.add('snapshots');
        this.pushPaths.set(event.exchange, event.path.startsWith('/sync/push'));
        if (event.path.startsWith('/sync/push')) {
          const sent = sentPush(event.body);
          if (sent) this.sentPushes.set(event.exchange, sent);
        }
        break;
      case 'delivered':
      case 'redelivered': {
        if (event.kind === 'delivered') this.stats.add(`requestFault:${event.fault}`);
        else this.stats.add('redelivered');
        this.stats.add('resets', event.responses.filter((r) => r.status === 410).length);
        const errors = event.responses.flatMap((r) => r.errors);
        // A rejection either fails the request (a recorded MutationRejected) or is reported per mutation.
        this.stats.add('serverRejections', errors.filter((e) => e.startsWith('MutationRejected')).length);
        if (this.pushPaths.get(event.exchange)) {
          for (const r of event.responses) {
            const codes = rejectedCodes(r.status, r.body);
            this.stats.add('serverRejections', codes.length);
            for (const code of codes) {
              if (!(this.profile.rejectionCodes as readonly string[]).includes(code)) {
                this.unexpectedRejections.push({ client: event.client, code });
              }
            }
          }
          const sent = this.sentPushes.get(event.exchange);
          for (const r of event.responses) if (sent) this.recordApplied(sent, pushResults(r.status, r.body));
          if (event.kind === 'delivered') this.lastPushErrors.set(event.client, errors);
        }
        break;
      }
      case 'answered':
        this.stats.add(`responseFault:${event.fault}`);
        break;
      case 'link':
        this.stats.add(`link:${event.state}`);
        break;
    }
  }
}

/** The fast-check model of the run. Steps carry no preconditions, so it holds only the profile's name. */
export interface SimModel {
  readonly profile: string;
}

export type SimCommand = fc.AsyncCommand<SimModel, SimSystem>;

/** A fast-check command that executes one {@link Step} on the system. */
export class StepCommand implements SimCommand {
  constructor(readonly step: Step) {}

  check(): boolean {
    return true;
  }

  async run(_model: SimModel, system: SimSystem): Promise<void> {
    await system.execute(this.step);
  }

  toString(): string {
    return describeStep(this.step);
  }
}

/**
 * Runs one generated scenario against `server`: the fault-phase commands through
 * `fc.asyncModelRun`, then the heal phase, then the liveness and convergence checks.
 */
export async function runScenario(
  profile: Profile,
  server: SimServer,
  commands: Iterable<SimCommand>,
): Promise<RunResult> {
  const system = await SimSystem.start(profile, server);
  let violations: Violation[] = [];
  let quiescent = false;
  try {
    await fc.asyncModelRun(() => ({ model: { profile: profile.name }, real: system }), commands);
    quiescent = await system.heal();
    violations = await system.verdict(quiescent);
  } catch (err) {
    // An exception from the client code (for example while computing its view) is a finding;
    // one from the harness or the server binding propagates instead.
    if (!(err instanceof ClientError)) throw err;
    violations = [{ signature: 'client-error', detail: err.message }];
  } finally {
    system.dispose();
  }
  system.stats.add('steps', system.script.length);
  return {
    profile: profile.name,
    script: system.script,
    violations,
    quiescent,
    stats: system.stats.values,
    trace: system.trace,
    traceHash: createHash('sha256').update(system.trace.join('\n')).digest('hex'),
  };
}

/** Thrown by the simulation property for a run with violations the profile does not allow. */
export class SimulationFailure extends Error {
  constructor(
    readonly result: RunResult,
    readonly unexpected: readonly Violation[],
  ) {
    super(`${result.profile}: ${unexpected.map((v) => v.signature).join(', ')}`);
    this.name = 'SimulationFailure';
  }
}

/** Thrown by the simulation property instead of running a scenario once its abort signal fired. */
export class SimulationInterrupted extends Error {
  constructor() {
    super('the simulation was interrupted');
    this.name = 'SimulationInterrupted';
  }
}

/**
 * The convergence property of a profile as a fast-check async property over generated scenarios.
 * Violations of known defects that the profile allows pass (they are counted through `onRun`);
 * any other violation fails the property with a {@link SimulationFailure}. Once `signal` fires, the
 * next run throws {@link SimulationInterrupted} instead, which stops fast-check.
 */
export function simulationProperty(
  profile: Profile,
  server: SimServer,
  commandsArb: fc.Arbitrary<Iterable<SimCommand>>,
  onRun: (result: RunResult) => void = () => undefined,
  signal?: AbortSignal,
): fc.IAsyncPropertyWithHooks<[Iterable<SimCommand>]> {
  return fc.asyncProperty(commandsArb, async (commands) => {
    if (signal?.aborted) throw new SimulationInterrupted();
    const result = await runScenario(profile, server, commands);
    onRun(result);
    const unexpected = result.violations.filter((v) => !profile.allowed.includes(v.signature));
    if (unexpected.length > 0) throw new SimulationFailure(result, unexpected);
  });
}
