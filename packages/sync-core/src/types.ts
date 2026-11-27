export type EntityName = 'ticket' | 'part';

/**
 * A position in the server's change log: a change's version, a cursor, a snapshot watermark, the
 * floor. Branded so that it cannot be mixed up with the other integers of the protocol (mutation
 * ids above all) without the compiler noticing; on the wire it is a plain JSON number.
 */
export type Version = number & { readonly __brand: 'Version' };

/** A version from a number: a non-negative integer that JSON carries exactly. Throws a RangeError otherwise. */
export function asVersion(n: number): Version {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a change-log version: ${n}`);
  return n as Version;
}

/**
 * The id a client gives one of its mutations: 1, 2, 3, … per client id. Branded like
 * {@link Version}; on the wire it is a plain JSON number.
 */
export type MutationId = number & { readonly __brand: 'MutationId' };

/** Whether a value is a mutation id: a positive integer that JSON carries exactly. */
export function isMutationId(value: unknown): value is MutationId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A mutation id from a number, see {@link isMutationId}. Throws a RangeError otherwise. */
export function asMutationId(n: number): MutationId {
  if (!isMutationId(n)) throw new RangeError(`not a mutation id: ${n}`);
  return n;
}

/**
 * The last mutation id handled for a client id, 0 while there is none. A union with the literal and
 * not a brand of its own: it is a mutation id as soon as it is not 0, with no conversion between the
 * two, and no other number (a {@link Version}, a count) can take its place.
 */
export type LastMutationId = MutationId | 0;

/** Whether a value is a {@link LastMutationId}: 0 or a mutation id. */
export function isLastMutationId(value: unknown): value is LastMutationId {
  return value === 0 || isMutationId(value);
}

/** A {@link LastMutationId} from a number, see {@link isLastMutationId}. Throws a RangeError otherwise. */
export function asLastMutationId(n: number): LastMutationId {
  if (!isLastMutationId(n)) throw new RangeError(`not a last mutation id: ${n}`);
  return n;
}

/**
 * The id of a client installation: a UUID in lower case, the form `crypto.randomUUID` and
 * PostgreSQL write. A UUID in another case is the same id (RFC 9562, section 4), so whoever takes
 * one from outside lowers it first. Branded so that no other string can take its place.
 */
export type ClientId = string & { readonly __brand: 'ClientId' };

const LOWER_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a value is a client id, see {@link ClientId}. */
export function isClientId(value: unknown): value is ClientId {
  return typeof value === 'string' && LOWER_CASE_UUID.test(value);
}

/** A client id from a string, see {@link isClientId}. Throws a RangeError otherwise. */
export function asClientId(value: string): ClientId {
  if (!isClientId(value)) throw new RangeError(`not a client id (a UUID in lower case): ${value}`);
  return value;
}

export type Row = Record<string, unknown>;

export type MutatorName =
  'ticket.create' | 'ticket.update' | 'ticket.setStatus' | 'ticket.delete' | 'part.add' | 'part.adjust';

export interface Mutation {
  /** Strictly increasing per client, starting at 1. */
  id: MutationId;
  name: MutatorName;
  args: Record<string, unknown>;
}

/**
 * Why the server refused a mutation. Every code but `INTERNAL` describes the mutation or the data it
 * met; `INTERNAL` means the server could not run it (a defect, not a retryable condition), and says
 * nothing more. A rejected mutation is final: the client drops it from its queue and shows it.
 */
export const REJECTION_CODES = [
  'BAD_ARGS',
  'NOT_FOUND',
  'FORBIDDEN',
  'ID_CONFLICT',
  'STATUS_CONFLICT',
  'INVALID_TRANSITION',
  'NEGATIVE_QUANTITY',
  'FIELD_CONFLICT',
  'UNKNOWN_MUTATOR',
  'INTERNAL',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** The facts a rejection carries for the codes that have them, so the user can act on it. */
export interface RejectionDetails {
  /** The ticket's status changed since the mutation was queued. */
  STATUS_CONFLICT: { current: TicketStatus; allowed: readonly TicketStatus[] };
  /** The state machine has no such step; `allowed` lists the steps from `from`. */
  INVALID_TRANSITION: { from: TicketStatus; to: string; allowed: readonly TicketStatus[] };
  /** The adjustment would take the stored quantity below zero. */
  NEGATIVE_QUANTITY: { quantity: number; delta: number };
  /**
   * Fields the edit changes were changed by someone else since the user saw them: for each, the
   * value it has now and the one the user typed, so the user can keep either.
   */
  FIELD_CONFLICT: { fields: ReadonlyArray<{ field: EditableTicketField; current: string; yours: string }> };
}

/** The ticket fields `ticket.update` edits. */
export type EditableTicketField = 'title' | 'description';

export interface Rejection {
  code: RejectionCode;
  /** For people; not for parsing. */
  message: string;
  /** Present for the codes in {@link RejectionDetails}. */
  details?: RejectionDetails[keyof RejectionDetails];
}

export type MutationResult =
  /**
   * `version` is the change-log version of the mutation's last change: a client has the mutation's
   * effect once its cursor reaches it. Absent when the mutation changed nothing.
   */
  | { id: MutationId; status: 'applied'; version?: Version }
  /**
   * The server had this mutation id already, so it applied nothing now; `version` as for `applied`
   * (absent too when the original result has expired, see the change-log retention).
   */
  | { id: MutationId; status: 'duplicate'; version?: Version }
  | ({ id: MutationId; status: 'rejected' } & Rejection);

export type MutationStatus = MutationResult['status'];

/**
 * The most bytes (UTF-8 JSON) one push body may have. The client splits its queue into bodies of at
 * most this size and refuses a single mutation that would not fit; the server accepts at least this
 * much (its JSON body limit can only be configured higher).
 */
export const MAX_PUSH_BODY_BYTES = 1_048_576;

/** The most mutations one push may carry. */
export const MAX_PUSH_MUTATIONS = 100;

export interface PushRequest {
  clientId: ClientId;
  mutations: Mutation[];
}

/** A mutation as the server receives it: any name may arrive, unknown ones are rejected. */
export interface ReceivedMutation {
  id: MutationId;
  name: string;
  args: Record<string, unknown>;
}

export interface PushResponse {
  results: MutationResult[];
  lastMutationId: LastMutationId;
}

export interface Change {
  version: Version;
  entity: EntityName;
  id: string;
  siteId: string;
  op: 'put' | 'del';
  data: Row | null;
}

export interface PullResponse {
  changes: Change[];
  nextCursor: Version;
  hasMore: boolean;
  lastMutationId: LastMutationId;
  /**
   * The head of the log in the database snapshot this page was read from; `lastMutationId` comes from
   * the same snapshot. Every change up to it is on this page or a later one. A client that keeps
   * pulling until its cursor reaches the head of its first page ends after a bounded number of pages,
   * however fast others write.
   */
  head: Version;
}

/** A live row of a snapshot. */
export interface SnapshotRow {
  entity: EntityName;
  id: string;
  siteId: string;
  data: Row;
}

/** Where a snapshot page ends; the next page starts after it (rows are ordered by site, entity, id). */
export interface SnapshotKey {
  siteId: string;
  entity: EntityName;
  id: string;
}

/**
 * One page of a snapshot: live rows of the user's sites in key order. `watermark` is the head of the
 * change log when the snapshot started; every page of one snapshot carries it, and after the last
 * page (`next` null) the client pulls the log from it, which makes the rows it read consistent.
 */
export interface SnapshotPage {
  watermark: Version;
  /**
   * The head of the log when this page was read: no row of the page holds a change after it. Once the
   * client has pulled the log from the watermark up to the highest head of the pages, the rows and the
   * log form one state of the server, even while writes go on (the point of consistency).
   */
  head: Version;
  rows: SnapshotRow[];
  next: SnapshotKey | null;
}

/** A snapshot page to read: the first one (no watermark), or the one after `after`. */
export interface SnapshotRequest {
  watermark?: Version;
  after?: SnapshotKey;
  limit?: number;
}

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

/**
 * The request header that names the version of the sync protocol a client speaks. The server
 * accepts a range of versions; a client below it (or one that sends no version, as clients before
 * versioning did) is told to update (`CLIENT_UPDATE_REQUIRED`), one above it waits for the server
 * to be updated (`SERVER_UPDATE_REQUIRED`).
 */
export const PROTOCOL_HEADER = 'FieldSync-Protocol';

/**
 * The version of the sync protocol this code speaks: the mutation and result formats, the pull,
 * snapshot and stream answers. It changes when one side could no longer understand the other.
 */
export const PROTOCOL_VERSION = 1;
