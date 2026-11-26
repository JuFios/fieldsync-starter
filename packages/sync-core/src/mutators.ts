import type { EntityName, MutatorName, Row, TicketStatus } from './types';

export class MutationRejected extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'MutationRejected';
  }
}

export interface Key {
  entity: EntityName;
  id: string;
}

/** State access given to a mutator. Reads are served from rows loaded up front. */
export interface MutatorTx {
  /**
   * The time of this mutation (ISO 8601). Mutators take every timestamp from here and never read a
   * clock themselves: on the client it is the time the mutation was queued, fixed for every
   * recomputation of the optimistic view; on the server it is the server's clock when the mutation
   * is applied, which is what the stored row keeps.
   */
  now(): string;
  get(entity: EntityName, id: string): Row | undefined;
  /** Writes a row that already exists (or replaces one read in this mutation). */
  put(entity: EntityName, id: string, row: Row): void;
  /**
   * Creates a row under an id the client chose. Rejects with `ID_CONFLICT` when the id is taken,
   * including by a deleted row: a client-chosen id must never name, overwrite or revive another row.
   */
  insert(entity: EntityName, id: string, row: Row): void;
  del(entity: EntityName, id: string): void;
}

export interface MutatorDef {
  /** Rows the mutator needs to read; the executor loads them before calling apply. */
  reads(args: Record<string, unknown>): Key[];
  apply(tx: MutatorTx, args: Record<string, unknown>): void;
}

function def<A>(d: { reads(a: A): Key[]; apply(tx: MutatorTx, a: A): void }): MutatorDef {
  return d as unknown as MutatorDef;
}

export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: ['open'],
  cancelled: [],
};

/**
 * Rejects strings Postgres cannot store, so the client rejects them exactly like the server would:
 * NUL is not allowed in text or jsonb, and neither is an unpaired UTF-16 surrogate (a string that is
 * not well-formed, see `String.prototype.isWellFormed`).
 */
function storable(value: string, field: string): string {
  if (value.includes('\u0000') || !value.isWellFormed()) {
    throw new MutationRejected('BAD_ARGS', `${field} contains characters that cannot be stored`);
  }
  return value;
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new MutationRejected('BAD_ARGS', `${field} must be a non-empty string up to ${max} chars`);
  }
  return storable(value, field);
}

/** Optional text: anything but a string becomes empty; longer text is cut to `max` UTF-16 units. */
function optionalText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') return '';
  const kept = storable(value, field);
  if (kept.length <= max) return kept;
  // Never cut between the two halves of a surrogate pair: the half left over could not be stored.
  // `kept` is well-formed, so a cut can only break the pair that straddles it.
  const cut = kept.slice(0, max);
  return cut.isWellFormed() ? cut : kept.slice(0, max - 1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new MutationRejected('BAD_ARGS', `${field} must be a UUID`);
  }
  return value;
}

/** Checks the id arguments a mutator relies on, as the server does before running it. */
function uuids<A>(args: A, ...fields: Array<keyof A & string>): void {
  for (const field of fields) uuid(args[field], field);
}

interface CreateArgs {
  /** Chosen by the client before the mutation is queued, so every environment uses the same id. */
  id: string;
  siteId: string;
  title: string;
  description: string;
}
interface UpdateArgs {
  id: string;
  siteId: string;
  title: string;
  description: string;
}
interface StatusArgs {
  id: string;
  siteId: string;
  from: TicketStatus;
  to: TicketStatus;
}
interface DeleteArgs {
  id: string;
  siteId: string;
}
interface PartAddArgs {
  id: string;
  ticketId: string;
  siteId: string;
  name: string;
  quantity: number;
}
interface PartAdjustArgs {
  id: string;
  siteId: string;
  delta: number;
}

export const MUTATORS: Record<MutatorName, MutatorDef> = {
  'ticket.create': def<CreateArgs>({
    reads: () => [],
    apply(tx, a) {
      const id = uuid(a.id, 'id');
      const siteId = uuid(a.siteId, 'siteId');
      const ts = tx.now();
      tx.insert('ticket', id, {
        id,
        siteId,
        title: text(a.title, 200, 'title'),
        description: optionalText(a.description, 5000, 'description'),
        status: 'open',
        assigneeId: null,
        createdAt: ts,
        updatedAt: ts,
      });
    },
  }),

  'ticket.update': def<UpdateArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      uuids(a, 'id', 'siteId');
      const ticket = tx.get('ticket', a.id);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      tx.put('ticket', a.id, {
        ...ticket,
        title: text(a.title, 200, 'title'),
        description: optionalText(a.description, 5000, 'description'),
        updatedAt: tx.now(),
      });
    },
  }),

  'ticket.setStatus': def<StatusArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      uuids(a, 'id', 'siteId');
      const ticket = tx.get('ticket', a.id);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      if (ticket.status !== a.from) {
        throw new MutationRejected('STATUS_CONFLICT', `Status is now "${String(ticket.status)}"`);
      }
      if (!ALLOWED_TRANSITIONS[a.from]?.includes(a.to)) {
        throw new MutationRejected('INVALID_TRANSITION', `${a.from} -> ${a.to} is not allowed`);
      }
      tx.put('ticket', a.id, { ...ticket, status: a.to, updatedAt: tx.now() });
    },
  }),

  'ticket.delete': def<DeleteArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      uuids(a, 'id', 'siteId');
      if (!tx.get('ticket', a.id)) return;
      tx.del('ticket', a.id);
    },
  }),

  'part.add': def<PartAddArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.ticketId }],
    apply(tx, a) {
      uuids(a, 'id', 'ticketId', 'siteId');
      const ticket = tx.get('ticket', a.ticketId);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      if (!Number.isInteger(a.quantity) || a.quantity < 1 || a.quantity > 1000) {
        throw new MutationRejected('BAD_ARGS', 'quantity must be an integer from 1 to 1000');
      }
      tx.insert('part', a.id, {
        id: a.id,
        ticketId: a.ticketId,
        siteId: ticket.siteId,
        name: text(a.name, 100, 'name'),
        quantity: a.quantity,
      });
    },
  }),

  'part.adjust': def<PartAdjustArgs>({
    reads: (a) => [{ entity: 'part', id: a.id }],
    apply(tx, a) {
      uuids(a, 'id', 'siteId');
      const part = tx.get('part', a.id);
      if (!part) throw new MutationRejected('NOT_FOUND', 'Part no longer exists');
      if (!Number.isInteger(a.delta) || Math.abs(a.delta) > 1000) {
        throw new MutationRejected('BAD_ARGS', 'delta must be an integer between -1000 and 1000');
      }
      const quantity = (part.quantity as number) + a.delta;
      if (quantity < 0) throw new MutationRejected('NEGATIVE_QUANTITY', 'Quantity cannot go below zero');
      tx.put('part', a.id, { ...part, quantity });
    },
  }),
};
