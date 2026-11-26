import type { Row } from '@fieldsync/sync-core';
import type { StoredRow } from './types';

/** JSON with object keys sorted, so equal rows compare equal whatever their key order (jsonb reorders keys). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
