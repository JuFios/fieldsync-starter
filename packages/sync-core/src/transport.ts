import type { PullResponse, PushRequest, PushResponse } from './types';

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

export interface Transport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(cursor: number, clientId: string, limit?: number): Promise<PullResponse>;
}

export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async push(req: PushRequest): Promise<PushResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await errorOf('push', res);
    return (await res.json()) as PushResponse;
  }

  async pull(cursor: number, clientId: string, limit = 500): Promise<PullResponse> {
    const qs = new URLSearchParams({ cursor: String(cursor), clientId, limit: String(limit) });
    const res = await this.fetchImpl(`${this.baseUrl}/sync/pull?${qs.toString()}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw await errorOf('pull', res);
    return (await res.json()) as PullResponse;
  }
}
