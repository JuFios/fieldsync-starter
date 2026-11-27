import type { Row } from '@fieldsync/sync-core';
import stringify from 'safe-stable-stringify';
import type { StoredRow } from './types';

/**
 * JSON with object keys sorted (safe-stable-stringify), so equal rows compare equal whatever their
 * key order (jsonb reorders keys). As in JSON, an `undefined` property is left out and an
 * `undefined` array element is `null`; `undefined` itself is `null`.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value) ?? 'null';
}

export interface Divergence {
  /** Rows the server has in the client's sites that the client lacks. */
  missing: string[];
  /** Rows the client has that the server does not have in the client's sites. */
  unexpected: string[];
  /** Of the unexpected rows, those that belong to a site the client's user cannot access. */
  foreign: string[];
  /** Rows both have with different contents. */
  different: string[];
}

/**
 * The convergence property: once the queues are drained and the network is healed, a client holds
 * exactly the server's live rows of the sites its user can access, with the same contents.
 *
 * `server` comes straight from the server's tables and `accessible` from the scenario's fixtures,
 * so neither depends on the server's pull path or access checks: the system is never its own oracle.
 */
export function compareWithServer(
  server: readonly StoredRow[],
  accessible: ReadonlySet<string>,
  client: ReadonlyMap<string, Row>,
): Divergence | undefined {
  const expected = new Map<string, string>();
  const siteOf = new Map<string, string>();
  for (const row of server) {
    const key = `${row.entity}/${row.id}`;
    siteOf.set(key, row.siteId);
    if (accessible.has(row.siteId)) expected.set(key, canonicalJson(row.data));
  }
  const missing: string[] = [];
  const unexpected: string[] = [];
  const foreign: string[] = [];
  const different: string[] = [];
  for (const [key, json] of expected) {
    const actual = client.get(key);
    if (actual === undefined) missing.push(key);
    else if (canonicalJson(actual) !== json) different.push(key);
  }
  for (const [key, row] of client) {
    if (expected.has(key)) continue;
    unexpected.push(key);
    const site = siteOf.get(key) ?? (typeof row.siteId === 'string' ? row.siteId : undefined);
    if (site === undefined || !accessible.has(site)) foreign.push(key);
  }
  if (missing.length + unexpected.length + different.length === 0) return undefined;
  const sorted = (keys: string[]) => keys.sort();
  return {
    missing: sorted(missing),
    unexpected: sorted(unexpected),
    foreign: sorted(foreign),
    different: sorted(different),
  };
}

/** The ticket fields that edits write one by one; the lost-edit property is checked per field. */
export const TICKET_TEXT_FIELDS = ['title', 'description'] as const;
export type TicketTextField = (typeof TICKET_TEXT_FIELDS)[number];

/** The longest description, in UTF-16 code units, as documented for `ticket.create` and `ticket.update`. */
const DESCRIPTION_MAX = 5000;

/** The description as stored: cut to its limit, and one unit shorter when the cut splits a surrogate pair. */
function storedDescription(value: string): string {
  if (value.length <= DESCRIPTION_MAX) return value;
  const last = value.charCodeAt(DESCRIPTION_MAX - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return value.slice(0, splitsPair ? DESCRIPTION_MAX - 1 : DESCRIPTION_MAX);
}

/** What an applied mutation wrote into the text fields of one ticket. */
export interface TicketFieldWrite {
  ticket: string;
  fields: Partial<Record<TicketTextField, string>>;
}

/**
 * The text fields a mutation writes when it is applied, derived from its arguments by the documented
 * rules rather than by running the mutator: `ticket.create` writes both (a description that is not a
 * string is empty), `ticket.update` writes only the fields it carries.
 */
export function ticketFieldWrite(name: string, args: Readonly<Record<string, unknown>>): TicketFieldWrite | undefined {
  if (typeof args.id !== 'string') return undefined;
  const description = typeof args.description === 'string' ? storedDescription(args.description) : undefined;
  if (name === 'ticket.create') {
    return { ticket: args.id, fields: { title: String(args.title), description: description ?? '' } };
  }
  if (name !== 'ticket.update') return undefined;
  const fields: Partial<Record<TicketTextField, string>> = {};
  if (typeof args.title === 'string') fields.title = args.title;
  if (description !== undefined) fields.description = description;
  return { ticket: args.id, fields };
}

/**
 * The lost-edit property (category 9): every text field of a live ticket holds the value of the last
 * applied mutation that wrote that field, so an edit of one field never undoes another client's edit
 * of the other. `writes` are in the order the server applied them; `unordered` names tickets with a
 * write whose place in that order is unknown (its first answer was lost), which are not checked.
 * Returns one line per field that holds anything else.
 */
export function lostEdits(
  server: readonly StoredRow[],
  writes: readonly TicketFieldWrite[],
  unordered: ReadonlySet<string> = new Set(),
): string[] {
  const expected = new Map<string, Partial<Record<TicketTextField, string>>>();
  for (const w of writes) expected.set(w.ticket, { ...expected.get(w.ticket), ...w.fields });
  const lost: string[] = [];
  for (const row of server) {
    if (row.entity !== 'ticket' || unordered.has(row.id)) continue;
    const fields = expected.get(row.id);
    if (!fields) continue;
    for (const field of TICKET_TEXT_FIELDS) {
      const value = fields[field];
      if (value !== undefined && row.data[field] !== value) {
        lost.push(
          `ticket/${row.id}.${field}: stored ${canonicalJson(row.data[field])}, last written ${canonicalJson(value)}`,
        );
      }
    }
  }
  return lost.sort();
}
