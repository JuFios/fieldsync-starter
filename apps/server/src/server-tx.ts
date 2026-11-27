import {
  MutationRejected,
  mutatorNamed,
  type EntityName,
  type MutatorTx,
  type ClientId,
  type MutationId,
  type ReceivedMutation,
  type Row,
} from '@fieldsync/sync-core';
import { authorize } from './access';
import type { AuthUser } from './auth';
import type { Sql } from './db';

/**
 * A UUID in lower case, the form Postgres prints and crypto.randomUUID() makes. Only one spelling
 * is accepted because ids are also compared as text (a part's ticketId, the client's row keys).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Loaded {
  row: Row | undefined;
  siteId?: string;
}

interface Write {
  /** `insert` creates a row under a client-chosen id and must not replace any existing row. */
  op: 'put' | 'insert' | 'del';
  entity: EntityName;
  id: string;
  row?: Row;
}

class BufferedTx implements MutatorTx {
  readonly writes: Write[] = [];

  constructor(
    private readonly loaded: Map<string, Loaded>,
    private readonly time: string,
    /** Ticket id → ids of its parts, for the ticket the mutator declared in `partsOf`. */
    private readonly parts: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {}

  partsOf(ticketId: string): Row[] {
    const ids = this.parts.get(ticketId);
    if (!ids) throw new Error(`The parts of ticket ${ticketId} were not loaded (declare it in partsOf)`);
    return ids.map((id) => this.get('part', id)).filter((row): row is Row => row !== undefined);
  }

  now(): string {
    return this.time;
  }

  get(entity: EntityName, id: string): Row | undefined {
    return this.loaded.get(`${entity}/${id}`)?.row;
  }

  put(entity: EntityName, id: string, row: Row): void {
    this.loaded.set(`${entity}/${id}`, { row, siteId: row.siteId as string });
    this.writes.push({ op: 'put', entity, id, row });
  }

  insert(entity: EntityName, id: string, row: Row): void {
    if (this.loaded.get(`${entity}/${id}`)?.row) {
      throw new MutationRejected('ID_CONFLICT', `${entity} ${id} already exists`);
    }
    // Rows that were not read (or are deleted) are checked by the INSERT itself, see applyMutation.
    this.loaded.set(`${entity}/${id}`, { row, siteId: row.siteId as string });
    this.writes.push({ op: 'insert', entity, id, row });
  }

  del(entity: EntityName, id: string): void {
    const existing = this.loaded.get(`${entity}/${id}`);
    this.loaded.set(`${entity}/${id}`, { row: undefined, siteId: existing?.siteId });
    this.writes.push({ op: 'del', entity, id });
  }

  siteOf(entity: EntityName, id: string): string | undefined {
    return this.loaded.get(`${entity}/${id}`)?.siteId;
  }
}

function assertUuids(args: Record<string, unknown>): void {
  for (const field of ['id', 'ticketId', 'siteId']) {
    const value = args[field];
    if (value !== undefined && (typeof value !== 'string' || !UUID.test(value))) {
      throw new MutationRejected('BAD_ARGS', `${field} must be a UUID in lower case`);
    }
  }
}

/** A change the mutation made, to be written to the change log by {@link finishMutation}. */
export interface LogEntry {
  siteId: string;
  entity: EntityName;
  id: string;
  op: 'put' | 'del';
  data: Row | null;
}

/** Locks are taken in one order everywhere (entity, then id), so two mutations never deadlock. */
function byKey(a: { entity: string; id: string }, b: { entity: string; id: string }): number {
  return a.entity === b.entity ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.entity < b.entity ? -1 : 1;
}

/**
 * Applies one mutation inside the caller's transaction and returns the changes it made, for the
 * change log. `at` is the server time of the mutation (the mutator's `tx.now()`).
 *
 * The rows the mutator reads are locked first, in key order; the mutator runs on them; its writes
 * are then made to `entities`, also in key order (an insert locks the new key). The change log is
 * not touched here: the caller appends the returned entries as the last step of the transaction
 * ({@link finishMutation}), so the log's ordering lock is held only for the end of the transaction.
 */
export async function applyMutation(c: Sql, user: AuthUser, m: ReceivedMutation, at: Date): Promise<LogEntry[]> {
  const def = mutatorNamed(m.name);
  if (!def) throw new MutationRejected('UNKNOWN_MUTATOR', 'Unknown mutator');
  assertUuids(m.args);
  await authorize(c, user, m);

  const loaded = new Map<string, Loaded>();
  for (const key of [...def.reads(m.args)].sort(byKey)) {
    const { rows } = await c.query<{ data: Row | null; site_id: string; deleted: boolean }>(
      `SELECT data, site_id, deleted FROM entities WHERE entity = $1 AND id = $2 FOR UPDATE`,
      [key.entity, key.id],
    );
    const found = rows[0];
    loaded.set(`${key.entity}/${key.id}`, {
      row: found && !found.deleted ? (found.data ?? undefined) : undefined,
      siteId: found?.site_id,
    });
  }

  // The parts of a ticket, after the ticket itself (locked above), in id order.
  const parts = new Map<string, string[]>();
  const ofTicket = def.partsOf?.(m.args);
  if (ofTicket !== undefined) {
    const { rows } = await c.query<{ id: string; data: Row; site_id: string }>(
      `SELECT id, data, site_id FROM entities
        WHERE entity = 'part' AND NOT deleted AND data->>'ticketId' = $1
        ORDER BY id FOR UPDATE`,
      [ofTicket],
    );
    parts.set(
      ofTicket,
      rows.map((r) => r.id),
    );
    for (const r of rows) loaded.set(`part/${r.id}`, { row: r.data, siteId: r.site_id });
  }

  const tx = new BufferedTx(loaded, at.toISOString(), parts);
  def.apply(tx, m.args);

  // The last write to each row is the one that counts.
  const last = new Map<string, Write>();
  for (const w of tx.writes) last.set(`${w.entity}/${w.id}`, w);
  const entries: LogEntry[] = [];
  for (const w of [...last.values()].sort(byKey)) {
    const siteId = w.op === 'del' ? tx.siteOf(w.entity, w.id) : (w.row?.siteId as string);
    if (!siteId) continue;
    if (w.op === 'insert') {
      // DO NOTHING instead of catching a unique violation: the transaction stays usable, and an
      // insert that races a concurrent one with the same id waits for it and then sees the conflict.
      // A deleted row (tombstone) conflicts as well, so a client-chosen id can never revive or move it.
      // The version is set by appendToLog in the same transaction.
      const inserted = await c.query(
        `INSERT INTO entities (entity, id, site_id, data, deleted, version) VALUES ($1, $2, $3, $4, false, 0)
         ON CONFLICT (entity, id) DO NOTHING RETURNING id`,
        [w.entity, w.id, siteId, JSON.stringify(w.row)],
      );
      if (inserted.rowCount === 0) {
        throw new MutationRejected('ID_CONFLICT', `${w.entity} ${w.id} already exists`);
      }
    } else if (w.op === 'put') {
      await c.query(
        `INSERT INTO entities (entity, id, site_id, data, deleted, version) VALUES ($1, $2, $3, $4, false, 0)
         ON CONFLICT (entity, id) DO UPDATE SET site_id = EXCLUDED.site_id, data = EXCLUDED.data, deleted = false`,
        [w.entity, w.id, siteId, JSON.stringify(w.row)],
      );
    } else {
      await c.query(`UPDATE entities SET deleted = true, data = NULL WHERE entity = $1 AND id = $2`, [w.entity, w.id]);
    }
    entries.push({
      siteId,
      entity: w.entity,
      id: w.id,
      op: w.op === 'del' ? 'del' : 'put',
      data: w.op === 'del' ? null : (w.row ?? null),
    });
  }
  return entries;
}

/** How a mutation ended, as {@link finishMutation} records it. */
export interface MutationRecord {
  clientId: ClientId;
  mutationId: MutationId;
  status: 'applied' | 'rejected';
  code: string | null;
  message: string | null;
  details: unknown;
  /** The mutation's changes; empty for a rejection or a mutation that changed nothing. */
  entries: readonly LogEntry[];
  at: Date;
}

/**
 * Records how a mutation ended, as the last statement of its transaction, in one set-based
 * statement: takes the next versions from `log_head` (locking its one row until the transaction
 * ends; only when there are changes), appends the changes to the change log, stamps the changed
 * entities with their versions, stores the result in `mutation_results` and advances the client's
 * last mutation id. Because every writer takes the head last and holds it until it commits, versions
 * are assigned, and become visible to readers, in commit order and without gaps. The client's and
 * the entities' rows are locked before (see `PushService`), so the statement takes no other lock.
 * Returns the version of the mutation's last change, or undefined if it changed nothing.
 */
export async function finishMutation(c: Sql, r: MutationRecord): Promise<number | undefined> {
  const { rows } = await c.query<{ version: string | null }>(
    `WITH head AS (
       UPDATE log_head SET version = version + $1 WHERE id = 1 AND $1 > 0 RETURNING version
     ),
     logged AS (
       INSERT INTO change_log (version, site_id, entity, entity_id, op, data, created_at)
       SELECT head.version - $1 + e.ord, e.site_id, e.entity, e.entity_id, e.op, e.data, $7
         FROM head, unnest($2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::jsonb[])
              WITH ORDINALITY AS e (site_id, entity, entity_id, op, data, ord)
       RETURNING version, entity, entity_id
     ),
     stamped AS (
       UPDATE entities SET version = logged.version
         FROM logged
        WHERE entities.entity = logged.entity AND entities.id = logged.entity_id
     ),
     result AS (
       INSERT INTO mutation_results (client_id, mutation_id, status, code, message, details, version, created_at)
       VALUES ($8, $9, $10, $11, $12, $13, (SELECT version FROM head), $7)
       RETURNING version
     ),
     client AS (
       UPDATE clients SET last_mutation_id = $9 WHERE client_id = $8
     )
     SELECT version FROM result`,
    [
      r.entries.length,
      r.entries.map((e) => e.siteId),
      r.entries.map((e) => e.entity),
      r.entries.map((e) => e.id),
      r.entries.map((e) => e.op),
      r.entries.map((e) => (e.data === null ? null : JSON.stringify(e.data))),
      r.at,
      r.clientId,
      r.mutationId,
      r.status,
      r.code,
      r.message,
      r.details === undefined || r.details === null ? null : JSON.stringify(r.details),
    ],
  );
  const version = rows[0]?.version;
  return version === null || version === undefined ? undefined : Number(version);
}
