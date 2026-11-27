import type { RejectionCode } from '@fieldsync/sync-core';
import type { LinkState, RequestFault, ResponseFault } from './network';
import { SIM_RETENTION_MS, type Role } from './types';

/** What a simulated user does; the generator turns a kind into a concrete mutation. */
export const ACTION_KINDS = [
  'create-ticket',
  'edit-ticket',
  'change-status',
  'delete-ticket',
  'add-part',
  'increase-part',
  'adjust-part',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** What a command of the fault phase does (see `StepCommand`). */
export const STEP_KINDS = [
  'act',
  'sync',
  'deliver',
  'respond',
  'redeliver',
  'tick',
  'link',
  'compact',
  'away',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Classes of violation. A violation's signature says which defect it shows; profiles list the
 * signatures of known defects owned by later changes, which are tolerated (see {@link KNOWN_SIGNATURES}).
 */
export const SIGNATURES = [
  /** A client's queue never drained because the server answered 500 to a mutation it rejected. */
  'rejected-mutation-500',
  /** The server rejected a mutation with a code none of the profile's actions can cause. */
  'unexpected-rejection',
  /** A client waits forever on a request that never completes. */
  'stuck-request',
  /** A client never drained its queue for another reason. */
  'livelock',
  /** A client holds rows of a site its user cannot access. */
  'foreign-site-rows',
  /** A client's rows differ from the server's rows within the sites its user can access. */
  'divergence',
  /** The client code threw where it must not (for example while computing its view). */
  'client-error',
  /** A ticket field does not hold the value of the last applied mutation that wrote it. */
  'lost-edit',
  /** A client dropped a queued mutation that the server never handled. */
  'lost-mutation',
] as const;
export type Signature = (typeof SIGNATURES)[number];

export interface KnownSignature {
  /** Found-issues id of the defect the signature shows. */
  defect: string;
  /** Area slug of the change that fixes it, as in known-defect tests. */
  owner: string;
  reason: string;
}

/** Signatures of known defects that later changes fix. Everything else is a failure. */
export const KNOWN_SIGNATURES: Partial<Record<Signature, KnownSignature>> = {
  'foreign-site-rows': {
    defect: 'F-07',
    owner: 'access-control',
    reason: "incremental pull returns other sites' changes",
  },
  'stuck-request': {
    defect: 'F-13',
    owner: 'offline-client',
    reason: 'requests have no timeout, so a request that never answers blocks syncing forever',
  },
};

export interface UserSpec {
  role: Role;
  /** Indexes into the profile's sites; ignored for admins. */
  sites: readonly number[];
}

export interface ClientSpec {
  /** Index into the profile's users; two clients of one user are two devices. */
  user: number;
  /** How far this client's clock is off, in ms (positive: ahead). */
  skewMs: number;
}

export interface Profile {
  name: string;
  description: string;
  sites: number;
  users: readonly UserSpec[];
  clients: readonly ClientSpec[];
  /** Most commands fast-check generates for the fault phase of one run. */
  maxCommands: number;
  /** Steps the system gets after the network heals to drain every queue; more is a livelock. */
  healSteps: number;
  /** The weights below are fast-check `oneof` weights, so they are integers. */
  stepWeights: Readonly<Record<StepKind, number>>;
  actionWeights: Readonly<Record<ActionKind, number>>;
  requestFaults: Readonly<Record<RequestFault, number>>;
  responseFaults: Readonly<Record<ResponseFault, number>>;
  /** Link state a `link` step switches to. */
  linkStates: Readonly<Record<LinkState, number>>;
  /** Users sometimes type text the server must reject (empty, too long, unstorable characters). */
  invalidText: boolean;
  /** Longest time a `tick` step lets pass, in ms (the client retries after 5 s). */
  maxTickMs: number;
  /**
   * How long an `away` step keeps a client away, in ms of virtual time: longer than the server's
   * change-log retention ({@link SIM_RETENTION_MS}), so a `compact` step after it leaves the
   * client's cursor behind the floor and the client has to be reset.
   */
  awayMs: number;
  /** Known-defect signatures this profile may produce (see {@link KNOWN_SIGNATURES}). */
  allowed: readonly Signature[];
  /**
   * Rejection codes the profile's actions can legitimately cause. Any other code, `INTERNAL` above
   * all, means the client and the server disagree about a mutation the user was allowed to make.
   */
  rejectionCodes: readonly RejectionCode[];
  /**
   * Lower bounds on the average per seed of run statistics (see `RunStats`), so a profile cannot
   * quietly stop exercising what it is meant to. Lowering one needs a reason in the README.
   */
  minimumPerSeed: Readonly<Record<string, number>>;
}

/** Concurrent edits of one field: the later one is rejected with the current value (3.3.5). */
const SAME_FIELD_EDITS: readonly RejectionCode[] = ['FIELD_CONFLICT'];

const NO_ACTIONS: Record<ActionKind, number> = {
  'create-ticket': 0,
  'edit-ticket': 0,
  'change-status': 0,
  'delete-ticket': 0,
  'add-part': 0,
  'increase-part': 0,
  'adjust-part': 0,
};

/** Every network fault, each common enough to occur several times per seed. */
const ALL_REQUEST_FAULTS = { none: 20, 'drop-request': 4, duplicate: 3, 'hold-copy': 3, hang: 0 } as const;
const ALL_RESPONSE_FAULTS = { none: 10, 'drop-response': 2, 'bad-gateway': 1, truncate: 1 } as const;
const ALL_LINK_STATES = { up: 3, down: 2, 'responses-lost': 1 } as const;
const STEPS = {
  act: 60,
  sync: 15,
  deliver: 60,
  respond: 60,
  redeliver: 10,
  tick: 15,
  link: 8,
  compact: 4,
  away: 3,
} as const;

/**
 * Writes to a row another client wrote last, per seed. A client that starts (every client, at the
 * start of a run) reads a snapshot and then the log, one exchange more than a pull, before it sees
 * the other clients' rows, so fewer of its first writes land on them; `compact` and `away` steps
 * take a share of the commands too (README, Simulation).
 */
const CONTENTION = 0.8;
/** Users of different sites see fewer of each other's tickets, so fewer rows have several writers. */
const CONTENTION_MULTI_SITE = 0.6;
/** Statistics every profile must keep up: each fault happens, clients contend for the same rows. */
/**
 * The log lifecycle in every profile: the server compacts its log, a client is away longer than the
 * retention, and a client is reset (410) and reloads from a snapshot.
 */
const LIFECYCLE_MINIMUM = { compactions: 0.8, away: 0.5, resets: 0.1 } as const;
const NETWORK_MINIMUM = {
  'requestFault:drop-request': 1,
  'requestFault:duplicate': 0.7,
  'requestFault:hold-copy': 0.7,
  redelivered: 0.5,
  'responseFault:drop-response': 1,
  'responseFault:bad-gateway': 0.4,
  'responseFault:truncate': 0.4,
  'link:down': 0.5,
  'link:responses-lost': 0.2,
  timersFired: 1,
} as const;

/**
 * One site, three technicians on four devices (one technician has two), all network faults except
 * hung requests, and only actions the server can never reject: creates, edits of any visible ticket
 * (so clients contend for the same rows), new parts and positive adjustments. Must converge on
 * every seed.
 */
const baseline: Profile = {
  name: 'baseline',
  description: 'one site, every network fault, no action the server can reject; must converge',
  sites: 1,
  users: [
    { role: 'technician', sites: [0] },
    { role: 'technician', sites: [0] },
    { role: 'technician', sites: [0] },
  ],
  clients: [
    { user: 0, skewMs: 0 },
    { user: 1, skewMs: 90_000 },
    { user: 2, skewMs: -45_000 },
    { user: 0, skewMs: 3_000 },
  ],
  maxCommands: 180,
  healSteps: 400,
  stepWeights: STEPS,
  actionWeights: { ...NO_ACTIONS, 'create-ticket': 2, 'edit-ticket': 6, 'add-part': 2, 'increase-part': 2 },
  requestFaults: ALL_REQUEST_FAULTS,
  responseFaults: ALL_RESPONSE_FAULTS,
  linkStates: ALL_LINK_STATES,
  invalidText: false,
  maxTickMs: 8_000,
  awayMs: 2 * SIM_RETENTION_MS,
  allowed: [],
  // Creates, edits and parts of existing tickets: the server applies every one, except an edit of a
  // field another client changed since the user saw it.
  rejectionCodes: SAME_FIELD_EDITS,
  minimumPerSeed: { ...NETWORK_MINIMUM, ...LIFECYCLE_MINIMUM, crossClientWrites: CONTENTION, 'action:edit-ticket': 6 },
};

/**
 * What the rejectable actions cause: status races (`STATUS_CONFLICT`), statuses an outdated screen
 * offers (`INVALID_TRANSITION`), edits and parts of deleted tickets (`NOT_FOUND`), adjustments near
 * zero (`NEGATIVE_QUANTITY`) and text the server must refuse (`BAD_ARGS`).
 */
const REJECTABLE: readonly RejectionCode[] = [
  'STATUS_CONFLICT',
  'INVALID_TRANSITION',
  'NOT_FOUND',
  'NEGATIVE_QUANTITY',
  'BAD_ARGS',
  'FIELD_CONFLICT',
];

/**
 * While incremental pulls leak other sites' tickets (F-07), a client can edit one of them and the
 * server refuses it with FORBIDDEN; the access-control change removes this code with the defect.
 */
const FOREIGN_TICKET_EDITS: readonly RejectionCode[] = ['FORBIDDEN'];

/** Baseline plus every action that can be rejected: status races, deletes against edits, adjustments near zero. */
const rejections: Profile = {
  ...baseline,
  name: 'rejections',
  description: 'one site, every network fault, every action including ones the server rejects',
  actionWeights: {
    'create-ticket': 4,
    'edit-ticket': 6,
    'change-status': 8,
    'delete-ticket': 3,
    'add-part': 4,
    'increase-part': 2,
    'adjust-part': 6,
  },
  invalidText: true,
  allowed: [],
  rejectionCodes: REJECTABLE,
  minimumPerSeed: {
    ...NETWORK_MINIMUM,
    ...LIFECYCLE_MINIMUM,
    crossClientWrites: CONTENTION,
    serverRejections: 1,
    'action:change-status': 3,
  },
};

/** Two sites, technicians of one site each, a technician of both and an admin; no rejectable actions. */
const multiSite: Profile = {
  ...baseline,
  name: 'multi-site',
  description: 'two sites, users with different access, every network fault, no rejectable action',
  sites: 2,
  users: [
    { role: 'technician', sites: [0] },
    { role: 'technician', sites: [1] },
    { role: 'technician', sites: [0, 1] },
    { role: 'admin', sites: [] },
  ],
  clients: [
    { user: 0, skewMs: 0 },
    { user: 1, skewMs: -20_000 },
    { user: 2, skewMs: 60_000 },
    { user: 3, skewMs: 1_000 },
  ],
  allowed: ['foreign-site-rows'],
  rejectionCodes: [...FOREIGN_TICKET_EDITS, ...SAME_FIELD_EDITS],
  minimumPerSeed: {
    ...NETWORK_MINIMUM,
    ...LIFECYCLE_MINIMUM,
    crossClientWrites: CONTENTION_MULTI_SITE,
    'action:edit-ticket': 6,
  },
};

/** Everything at once, hung requests included. */
const full: Profile = {
  ...multiSite,
  name: 'full',
  description: 'two sites, every network fault including hung requests, every action',
  actionWeights: rejections.actionWeights,
  invalidText: true,
  requestFaults: { ...ALL_REQUEST_FAULTS, hang: 1 },
  allowed: ['foreign-site-rows', 'stuck-request'],
  rejectionCodes: [...REJECTABLE, ...FOREIGN_TICKET_EDITS],
  minimumPerSeed: {
    ...NETWORK_MINIMUM,
    ...LIFECYCLE_MINIMUM,
    crossClientWrites: CONTENTION_MULTI_SITE,
    serverRejections: 1,
    'action:change-status': 3,
  },
};

export const PROFILES = { baseline, rejections, 'multi-site': multiSite, full } satisfies Record<string, Profile>;
export type ProfileName = keyof typeof PROFILES;

export function profileNamed(name: string): Profile {
  if (!(name in PROFILES)) throw new Error(`unknown profile "${name}" (known: ${Object.keys(PROFILES).join(', ')})`);
  return PROFILES[name as ProfileName];
}
