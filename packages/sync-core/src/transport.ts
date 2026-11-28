import { createParser } from 'eventsource-parser';
import {
  isLastMutationId,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type ClientId,
  type EntityName,
  type LastMutationId,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SnapshotPage,
  type SnapshotRequest,
} from './types';

/**
 * A request the server answered with an error (a problem, RFC 9457): `code` says what happened
 * (`MUTATION_OUT_OF_ORDER`, `TRANSIENT`, `PAYLOAD_TOO_LARGE`, ...), `details` the facts the client
 * can act on, `retryAfterSeconds` when a retry may succeed.
 */
export class TransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** The TransportError for an answer that is not ok, from its problem body when it has one. */
async function errorOf(what: string, res: Response): Promise<TransportError> {
  // Retry-After in seconds; its HTTP-date form is not used by this server.
  const header = res.headers.get('retry-after');
  const retryAfterSeconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
  let problem: { code?: unknown; detail?: unknown; details?: unknown } = {};
  if (/^application\/problem\+json/.test(res.headers.get('content-type') ?? '')) {
    problem = await res.json().then(
      (body: unknown) => (body !== null && typeof body === 'object' ? body : {}),
      () => ({}),
    );
  }
  const code = typeof problem.code === 'string' ? problem.code : 'HTTP_ERROR';
  const detail = typeof problem.detail === 'string' ? problem.detail : `HTTP ${res.status}`;
  const details =
    problem.details !== null && typeof problem.details === 'object'
      ? (problem.details as Record<string, unknown>)
      : undefined;
  return new TransportError(res.status, code, `${what} failed: ${detail}`, details, retryAfterSeconds);
}

/** The problem code of a pull or snapshot whose cursor is below the floor of the change log (410). */
export const RESET_REQUIRED = 'RESET_REQUIRED';

/**
 * An event of the notification stream (`GET /sync/stream`): `ready` first, with the heartbeat
 * interval; `poke` when a site of the user changed (pull then); `heartbeat` while nothing happens.
 */
export type StreamEvent = { type: 'ready'; heartbeatMs: number } | { type: 'poke' } | { type: 'heartbeat' };

/** A stream event from its SSE name and data; undefined for anything else (ignored, as browsers do). */
export function streamEventOf(name: string | undefined, data: string): StreamEvent | undefined {
  if (name === 'poke') return { type: 'poke' };
  if (name === 'heartbeat') return { type: 'heartbeat' };
  if (name !== 'ready') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  const ms =
    parsed !== null && typeof parsed === 'object' ? (parsed as { heartbeatMs?: unknown }).heartbeatMs : undefined;
  return typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0 ? { type: 'ready', heartbeatMs: ms } : undefined;
}

/** Options of one request; `signal` aborts it (the client aborts its requests when it is disposed). */
export interface RequestOptions {
  signal?: AbortSignal;
}

export interface Transport {
  push(req: PushRequest, init?: RequestOptions): Promise<PushResponse>;
  pull(cursor: number, clientId: ClientId, limit?: number, init?: RequestOptions): Promise<PullResponse>;
  /** One page of a snapshot of the live state (see {@link SnapshotPage}). */
  snapshot(req: SnapshotRequest, init?: RequestOptions): Promise<SnapshotPage>;
  /**
   * Opens the notification stream and calls `onEvent` for each event until the stream ends (then it
   * resolves) or fails (then it rejects, with a TransportError for an error answer). Optional: a
   * client without it learns of changes only when it syncs.
   */
  stream?(onEvent: (event: StreamEvent) => void, init?: RequestOptions): Promise<void>;
  /**
   * Retires a client id of the user (after a 409): the server applies nothing new under it. Resolves
   * with the last mutation id handled under it, which no later request changes. Optional: without it
   * a client cannot recover from a 409 and reports it.
   */
  retire?(clientId: ClientId, init?: RequestOptions): Promise<{ lastMutationId: LastMutationId }>;
}

const ENTITIES: readonly EntityName[] = ['ticket', 'part'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVersion(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEntity(value: unknown): value is EntityName {
  return typeof value === 'string' && (ENTITIES as readonly string[]).includes(value);
}

/**
 * Whether a body is a snapshot page. The client replaces its whole state from snapshot pages, so a
 * malformed one (a proxy's error page with status 200, a truncated body) must fail the snapshot
 * instead of being taken for an empty state.
 */
export function isSnapshotPage(body: unknown): body is SnapshotPage {
  if (!isRecord(body) || !isVersion(body.watermark) || !isVersion(body.head) || !Array.isArray(body.rows)) return false;
  const rowsOk = body.rows.every(
    (r: unknown) =>
      isRecord(r) && isEntity(r.entity) && typeof r.id === 'string' && typeof r.siteId === 'string' && isRecord(r.data),
  );
  const next: unknown = body.next;
  const nextOk =
    next === null ||
    (isRecord(next) && typeof next.siteId === 'string' && isEntity(next.entity) && typeof next.id === 'string');
  return rowsOk && nextOk;
}

/** The `signal` member of a fetch init, present only when there is a signal. */
function signalOf(init: RequestOptions): { signal?: AbortSignal } {
  return init.signal === undefined ? {} : { signal: init.signal };
}

export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** Headers of every request: the token and the protocol version this client speaks. */
  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
  }

  async push(req: PushRequest, init: RequestOptions = {}): Promise<PushResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/sync/push`, {
      ...signalOf(init),
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await errorOf('push', res);
    return (await res.json()) as PushResponse;
  }

  async pull(cursor: number, clientId: ClientId, limit = 500, init: RequestOptions = {}): Promise<PullResponse> {
    const qs = new URLSearchParams({ cursor: String(cursor), clientId, limit: String(limit) });
    const res = await this.fetchImpl(`${this.baseUrl}/sync/pull?${qs.toString()}`, {
      ...signalOf(init),
      headers: this.headers(),
    });
    if (!res.ok) throw await errorOf('pull', res);
    return (await res.json()) as PullResponse;
  }

  /**
   * The stream over `fetch`, so that it carries the same headers as every other request (the bearer
   * token, never in the URL, and the protocol version: browsers' EventSource can send neither); the
   * body is parsed with `eventsource-parser`. Reconnecting is the client's job (see `SyncClient`).
   */
  async stream(onEvent: (event: StreamEvent) => void, init: RequestOptions = {}): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/sync/stream`, {
      ...signalOf(init),
      cache: 'no-store',
      headers: { ...this.headers(), accept: 'text/event-stream' },
    });
    if (!res.ok) throw await errorOf('stream', res);
    if (!/^text\/event-stream/.test(res.headers.get('content-type') ?? '') || !res.body) {
      throw new TransportError(res.status, 'BAD_RESPONSE', 'stream failed: not an event stream');
    }
    const parser = createParser({
      onEvent: (message) => {
        const event = streamEventOf(message.event, message.data);
        if (event) onEvent(event);
      },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  }

  async retire(clientId: ClientId, init: RequestOptions = {}): Promise<{ lastMutationId: LastMutationId }> {
    const res = await this.fetchImpl(`${this.baseUrl}/sync/clients/${encodeURIComponent(clientId)}`, {
      ...signalOf(init),
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw await errorOf('retire', res);
    const body: unknown = await res.json();
    const last =
      body !== null && typeof body === 'object' ? (body as { lastMutationId?: unknown }).lastMutationId : undefined;
    if (!isLastMutationId(last)) {
      throw new TransportError(res.status, 'BAD_RESPONSE', 'retire failed: no last mutation id');
    }
    return { lastMutationId: last };
  }

  async snapshot(req: SnapshotRequest, init: RequestOptions = {}): Promise<SnapshotPage> {
    const qs = new URLSearchParams();
    if (req.watermark !== undefined) qs.set('watermark', String(req.watermark));
    if (req.after !== undefined) {
      qs.set('afterSite', req.after.siteId);
      qs.set('afterEntity', req.after.entity);
      qs.set('afterId', req.after.id);
    }
    if (req.limit !== undefined) qs.set('limit', String(req.limit));
    const res = await this.fetchImpl(`${this.baseUrl}/sync/snapshot?${qs.toString()}`, {
      ...signalOf(init),
      headers: this.headers(),
    });
    if (!res.ok) throw await errorOf('snapshot', res);
    const body: unknown = await res.json();
    if (!isSnapshotPage(body))
      throw new TransportError(res.status, 'BAD_RESPONSE', 'snapshot failed: not a snapshot page');
    return body;
  }
}
