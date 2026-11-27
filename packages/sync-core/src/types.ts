export type EntityName = 'ticket' | 'part';

export type Row = Record<string, unknown>;

export type MutatorName =
  'ticket.create' | 'ticket.update' | 'ticket.setStatus' | 'ticket.delete' | 'part.add' | 'part.adjust';

export interface Mutation {
  /** Strictly increasing per client, starting at 1. */
  id: number;
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
  | { id: number; status: 'applied'; version?: number }
  /**
   * The server had this mutation id already, so it applied nothing now; `version` as for `applied`
   * (absent too when the original result has expired, see the change-log retention).
   */
  | { id: number; status: 'duplicate'; version?: number }
  | ({ id: number; status: 'rejected' } & Rejection);

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
  clientId: string;
  mutations: Mutation[];
}

/** A mutation as the server receives it: any name may arrive, unknown ones are rejected. */
export interface ReceivedMutation {
  id: number;
  name: string;
  args: Record<string, unknown>;
}

export interface PushResponse {
  results: MutationResult[];
  lastMutationId: number;
}

export interface Change {
  version: number;
  entity: EntityName;
  id: string;
  siteId: string;
  op: 'put' | 'del';
  data: Row | null;
}

export interface PullResponse {
  changes: Change[];
  nextCursor: number;
  hasMore: boolean;
  lastMutationId: number;
}

export type TicketStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
