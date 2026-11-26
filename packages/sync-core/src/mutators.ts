import type {
  EditableTicketField,
  EntityName,
  MutatorName,
  RejectionCode,
  RejectionDetails,
  Row,
  TicketStatus,
} from './types';

/** A mutator refuses the mutation; the server records it, the client shows it. */
export class MutationRejected extends Error {
  constructor(
    readonly code: RejectionCode,
    message?: string,
    readonly details?: RejectionDetails[keyof RejectionDetails],
  ) {
    super(message ?? code);
    this.name = 'MutationRejected';
  }
}

/** A rejection whose code carries details, typed by the code. */
export function rejectWith<C extends keyof RejectionDetails>(
  code: C,
  message: string,
  details: RejectionDetails[C],
): MutationRejected {
  return new MutationRejected(code, message, details);
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
  /**
   * The live parts of a ticket, ordered by id. Only for a mutator that declares the ticket in
   * {@link MutatorDef.partsOf}: the executor loads (and on the server locks) them up front.
   */
  partsOf(ticketId: string): Row[];
}

/** The live parts of a ticket in a map of `entity/id` keys to rows, ordered by id. */
export function partsInState(state: ReadonlyMap<string, Row>, ticketId: string): Row[] {
  return [...state]
    .filter(([key, row]) => key.startsWith('part/') && row.ticketId === ticketId)
    .map(([, row]) => row)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
}

export interface MutatorDef {
  /** Rows the mutator needs to read; the executor loads them before calling apply. */
  reads(args: Record<string, unknown>): Key[];
  /** A ticket whose parts the mutator needs (`MutatorTx.partsOf`), loaded after the rows of `reads`. */
  partsOf?(args: Record<string, unknown>): string | undefined;
  apply(tx: MutatorTx, args: Record<string, unknown>): void;
}

function def<A>(d: {
  reads(a: A): Key[];
  partsOf?(a: A): string | undefined;
  apply(tx: MutatorTx, a: A): void;
}): MutatorDef {
  return d as unknown as MutatorDef;
}

export const ALLOWED_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
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
/**
 * An edit names only the fields the user changed. `base` holds, for each of them, the value the user
 * saw when they started editing: when the stored value has changed since (someone else edited the
 * same field), the edit is rejected with FIELD_CONFLICT instead of overwriting that change. Without
 * a base for a field the edit simply writes it (the last write in server order wins).
 */
interface UpdateArgs {
  id: string;
  siteId: string;
  title?: unknown;
  description?: unknown;
  base?: unknown;
}
const EDITABLE_FIELDS: readonly EditableTicketField[] = ['title', 'description'];

/** The base values of an edit: a plain object of strings for the editable fields, or nothing. */
function baseOf(value: unknown): Partial<Record<EditableTicketField, string>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MutationRejected('BAD_ARGS', 'base must be an object');
  }
  const base: Partial<Record<EditableTicketField, string>> = {};
  for (const field of EDITABLE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const seen: unknown = (value as Record<string, unknown>)[field];
    if (typeof seen !== 'string') throw new MutationRejected('BAD_ARGS', `base.${field} must be a string`);
    base[field] = seen;
  }
  return base;
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
      const changes: Partial<Record<EditableTicketField, string>> = {};
      if (a.title !== undefined) changes.title = text(a.title, 200, 'title');
      if (a.description !== undefined) {
        if (typeof a.description !== 'string') throw new MutationRejected('BAD_ARGS', 'description must be a string');
        changes.description = optionalText(a.description, 5000, 'description');
      }
      const fields = EDITABLE_FIELDS.filter((f) => changes[f] !== undefined);
      if (fields.length === 0)
        throw new MutationRejected('BAD_ARGS', 'An edit must change the title or the description');
      const base = baseOf(a.base);
      const conflicts = fields.flatMap((field) => {
        const seen = base[field];
        const current = String(ticket[field]);
        const yours = changes[field] as string;
        // Writing the value that is already stored conflicts with nobody.
        return seen === undefined || seen === current || yours === current ? [] : [{ field, current, yours }];
      });
      if (conflicts.length > 0) {
        const names = conflicts.map((c) => c.field).join(' and ');
        const verb = conflicts.length === 1 ? 'was' : 'were';
        throw rejectWith('FIELD_CONFLICT', `${names} ${verb} changed by someone else`, { fields: conflicts });
      }
      tx.put('ticket', a.id, { ...ticket, ...changes, updatedAt: tx.now() });
    },
  }),

  'ticket.setStatus': def<StatusArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    apply(tx, a) {
      uuids(a, 'id', 'siteId');
      const ticket = tx.get('ticket', a.id);
      if (!ticket) throw new MutationRejected('NOT_FOUND', 'Ticket no longer exists');
      if (ticket.status !== a.from) {
        const current = ticket.status as TicketStatus;
        throw rejectWith('STATUS_CONFLICT', `Status is now "${current}"`, {
          current,
          allowed: ALLOWED_TRANSITIONS[current],
        });
      }
      if (!ALLOWED_TRANSITIONS[a.from].includes(a.to)) {
        throw rejectWith('INVALID_TRANSITION', `${a.from} -> ${String(a.to)} is not allowed`, {
          from: a.from,
          to: String(a.to),
          allowed: ALLOWED_TRANSITIONS[a.from],
        });
      }
      tx.put('ticket', a.id, { ...ticket, status: a.to, updatedAt: tx.now() });
    },
  }),

  'ticket.delete': def<DeleteArgs>({
    reads: (a) => [{ entity: 'ticket', id: a.id }],
    // A ticket's parts go with it, so no part outlives its ticket (F-31).
    partsOf: (a) => (typeof a.id === 'string' ? a.id : undefined),
    apply(tx, a) {
      uuids(a, 'id', 'siteId');
      if (!tx.get('ticket', a.id)) return;
      for (const part of tx.partsOf(a.id)) tx.del('part', String(part.id));
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
      const stored = part.quantity as number;
      const quantity = stored + a.delta;
      if (quantity < 0) {
        throw rejectWith('NEGATIVE_QUANTITY', 'Quantity cannot go below zero', { quantity: stored, delta: a.delta });
      }
      tx.put('part', a.id, { ...part, quantity });
    },
  }),
};

/**
 * The mutator a name refers to, or undefined. Only the table's own entries count: a plain lookup
 * would also find what every object inherits (`toString`, `constructor`, `__proto__`, ...).
 */
export function mutatorNamed(name: string): MutatorDef | undefined {
  return isMutatorName(name) ? MUTATORS[name] : undefined;
}

export function isMutatorName(name: string): name is MutatorName {
  return Object.hasOwn(MUTATORS, name);
}

/**
 * The arguments of `ticket.update` for what the user typed: only the fields that differ from what
 * they saw (`seen`), each with that value as its base. Undefined when nothing changed.
 */
export function ticketEdit(
  ticket: { id: string; siteId: string },
  seen: Readonly<Record<EditableTicketField, string>>,
  typed: Readonly<Record<EditableTicketField, string>>,
): Record<string, unknown> | undefined {
  const changed = EDITABLE_FIELDS.filter((f) => typed[f] !== seen[f]);
  if (changed.length === 0) return undefined;
  const args: Record<string, unknown> = { id: ticket.id, siteId: ticket.siteId };
  const base: Record<string, string> = {};
  for (const field of changed) {
    args[field] = typed[field];
    base[field] = seen[field];
  }
  return { ...args, base };
}
