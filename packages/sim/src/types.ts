import type { EntityName, Row } from '@fieldsync/sync-core';

/** One HTTP request as the server sees it. */
export interface SimRequest {
  method: string;
  /** Path and query, e.g. `/sync/pull?cursor=0&limit=500`. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

/** An exception the server raised while handling a request (recorded by the server binding). */
export interface ServerError {
  /** Class name, e.g. `MutationRejected`, `QueryFailedError`, `TypeError`. */
  name: string;
  /** `MutationRejected.code` or a Postgres SQLSTATE, when there is one. */
  code?: string;
}

export interface SimResponse {
  status: number;
  contentType: string | undefined;
  body: string;
  serverErrors: readonly ServerError[];
}

/** A live (not deleted) row as stored by the server, read straight from its tables. */
export interface StoredRow {
  entity: EntityName;
  id: string;
  siteId: string;
  data: Row;
}

export type Role = 'admin' | 'technician';

export interface SimUser {
  id: string;
  name: string;
  role: Role;
  token: string;
  /** Sites a technician is assigned to; ignored for admins, who can access every site. */
  sites: readonly string[];
}

export interface SimSite {
  id: string;
  name: string;
}

/** The sites and users of one run, created by the scenario and written by the server binding. */
export interface Fixtures {
  sites: readonly SimSite[];
  users: readonly SimUser[];
}

/**
 * The system under test as the simulation sees it. The server binding implements it with the real
 * server on a real database; the engine's own tests use an in-memory reference server.
 */
export interface SimServer {
  /** Empties all data, writes the fixtures and makes the server read time from `now` (epoch ms). */
  reset(fixtures: Fixtures, now: () => number): Promise<void>;
  /** Handles one request to completion. Must not throw for HTTP errors: they are responses. */
  send(request: SimRequest): Promise<SimResponse>;
  /** Every live row, independently of the server's own read paths (the oracle's source of truth). */
  liveRows(): Promise<StoredRow[]>;
  /**
   * Runs the change-log GC at the server's current (virtual) time, with the retention the binding
   * configured (see {@link SIM_RETENTION_MS}). Returns the number of log entries it removed.
   */
  compact(): Promise<number>;
  /** The last mutation id the server handled for each client id it knows, independently of its API. */
  handledMutations(): Promise<Map<string, number>>;
}

/** Change-log retention the server of a simulation runs with: one hour of virtual time. */
export const SIM_RETENTION_MS = 3_600_000;
