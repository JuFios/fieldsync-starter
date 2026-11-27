import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type EntityName,
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

export interface Transport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(cursor: number, clientId: string, limit?: number): Promise<PullResponse>;
  /** One page of a snapshot of the live state (see {@link SnapshotPage}). */
  snapshot(req: SnapshotRequest): Promise<SnapshotPage>;
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
  if (!isRecord(body) || !isVersion(body.watermark) || !Array.isArray(body.rows)) return false;
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

  async push(req: PushRequest): Promise<PushResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/sync/push`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await errorOf('push', res);
    return (await res.json()) as PushResponse;
  }

  async pull(cursor: number, clientId: string, limit = 500): Promise<PullResponse> {
    const qs = new URLSearchParams({ cursor: String(cursor), clientId, limit: String(limit) });
    const res = await this.fetchImpl(`${this.baseUrl}/sync/pull?${qs.toString()}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await errorOf('pull', res);
    return (await res.json()) as PullResponse;
  }

  async snapshot(req: SnapshotRequest): Promise<SnapshotPage> {
    const qs = new URLSearchParams();
    if (req.watermark !== undefined) qs.set('watermark', String(req.watermark));
    if (req.after !== undefined) {
      qs.set('afterSite', req.after.siteId);
      qs.set('afterEntity', req.after.entity);
      qs.set('afterId', req.after.id);
    }
    if (req.limit !== undefined) qs.set('limit', String(req.limit));
    const res = await this.fetchImpl(`${this.baseUrl}/sync/snapshot?${qs.toString()}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await errorOf('snapshot', res);
    const body: unknown = await res.json();
    if (!isSnapshotPage(body))
      throw new TransportError(res.status, 'BAD_RESPONSE', 'snapshot failed: not a snapshot page');
    return body;
  }
}
