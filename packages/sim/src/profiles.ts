import type { LinkState, RequestFault, ResponseFault } from './network';
import type { Role } from './types';

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

/** What the scheduler can do in one step of the fault phase. */
export const STEP_KINDS = ['act', 'sync', 'deliver', 'respond', 'redeliver', 'tick', 'link'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Classes of violation. A violation's signature says which defect it shows; profiles list the
 * signatures of known defects owned by later changes, which are tolerated (see {@link KNOWN_SIGNATURES}).
 */
export const SIGNATURES = [
  /** A client's queue never drained because the server answered 500 to a mutation it rejected. */
  'rejected-mutation-500',
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
  'rejected-mutation-500': {
    defect: 'F-23',
    owner: 'sync-protocol',
    reason: 'a rejected mutation fails the whole push with HTTP 500, so the queue never drains',
  },
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
  /** Steps of the fault phase. */
  steps: number;
  /** Steps the system gets after the network heals to drain every queue; more is a livelock. */
  healSteps: number;
  stepWeights: Readonly<Record<StepKind, number>>;
  actionWeights: Readonly<Record<ActionKind, number>>;
  requestFaults: Readonly<Record<RequestFault, number>>;
  responseFaults: Readonly<Record<ResponseFault, number>>;
  /** Link state a `link` step switches to. */
  linkStates: Readonly<Record<LinkState, number>>;
  /** Longest time a `tick` step lets pass, in ms (the client retries after 5 s). */
  maxTickMs: number;
  /** Known-defect signatures this profile may produce (see {@link KNOWN_SIGNATURES}). */
  allowed: readonly Signature[];
  /**
   * Lower bounds on the average per seed of run statistics (see `RunStats`), so a profile cannot
   * quietly stop exercising what it is meant to. Lowering one needs a reason in the README.
   */
  minimumPerSeed: Readonly<Record<string, number>>;
}

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
const ALL_REQUEST_FAULTS = { none: 10, 'drop-request': 2, duplicate: 1.5, 'hold-copy': 1.5, hang: 0 } as const;
const ALL_RESPONSE_FAULTS = { none: 10, 'drop-response': 2, 'bad-gateway': 1, truncate: 1 } as const;
const ALL_LINK_STATES = { up: 3, down: 2, 'responses-lost': 1 } as const;
const STEPS = { act: 6, sync: 1.5, deliver: 6, respond: 6, redeliver: 1, tick: 1.5, link: 0.6 } as const;

/** Statistics every profile must keep up: each fault happens, clients contend for the same rows. */
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
  steps: 90,
  healSteps: 400,
  stepWeights: STEPS,
  actionWeights: { ...NO_ACTIONS, 'create-ticket': 2, 'edit-ticket': 6, 'add-part': 2, 'increase-part': 2 },
  requestFaults: ALL_REQUEST_FAULTS,
  responseFaults: ALL_RESPONSE_FAULTS,
  linkStates: ALL_LINK_STATES,
  maxTickMs: 8_000,
  allowed: [],
  minimumPerSeed: { ...NETWORK_MINIMUM, contendedRows: 1.5, 'action:edit-ticket': 6 },
};

/** Baseline plus every action that can be rejected: status races, deletes against edits, adjustments near zero. */
const rejections: Profile = {
  ...baseline,
  name: 'rejections',
  description: 'one site, every network fault, every action including ones the server rejects',
  actionWeights: {
    'create-ticket': 2,
    'edit-ticket': 3,
    'change-status': 4,
    'delete-ticket': 1.5,
    'add-part': 2,
    'increase-part': 1,
    'adjust-part': 3,
  },
  allowed: ['rejected-mutation-500'],
  minimumPerSeed: { ...NETWORK_MINIMUM, contendedRows: 1.5, serverRejections: 1, 'action:change-status': 3 },
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
  // Users of different sites see fewer of each other's tickets, so fewer rows have several writers.
  minimumPerSeed: { ...NETWORK_MINIMUM, contendedRows: 1, 'action:edit-ticket': 6 },
};

/** Everything at once, hung requests included. */
const full: Profile = {
  ...multiSite,
  name: 'full',
  description: 'two sites, every network fault including hung requests, every action',
  actionWeights: rejections.actionWeights,
  requestFaults: { ...ALL_REQUEST_FAULTS, hang: 0.3 },
  allowed: ['rejected-mutation-500', 'foreign-site-rows', 'stuck-request'],
  minimumPerSeed: { ...NETWORK_MINIMUM, serverRejections: 1, 'action:change-status': 3 },
};

export const PROFILES = { baseline, rejections, 'multi-site': multiSite, full } satisfies Record<string, Profile>;
export type ProfileName = keyof typeof PROFILES;

export function profileNamed(name: string): Profile {
  if (!(name in PROFILES)) throw new Error(`unknown profile "${name}" (known: ${Object.keys(PROFILES).join(', ')})`);
  return PROFILES[name as ProfileName];
}
