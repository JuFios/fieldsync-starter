import type { SimRequest, SimResponse, SimServer } from './types';

/**
 * Faults applied when a request reaches the network.
 *
 * - `drop-request`: lost before the server sees it.
 * - `duplicate`: the server handles it twice in a row (a retrying proxy); the client gets the second answer.
 * - `hold-copy`: handled normally, and a copy is kept to be delivered again later (a stale retransmission).
 * - `hang`: the server handles it, but the answer never arrives and the connection never closes.
 * - `cut-request`: the connection breaks in the middle of the request body; the server gets half of
 *   the body (a request without a body never reaches it), the client gets no answer.
 */
export const REQUEST_FAULTS = ['none', 'drop-request', 'duplicate', 'hold-copy', 'hang', 'cut-request'] as const;
export type RequestFault = (typeof REQUEST_FAULTS)[number];

/**
 * Faults applied to an answer the server already produced (the request took effect).
 *
 * - `drop-response`: the connection breaks before the answer arrives.
 * - `bad-gateway`: a proxy answers 502 instead.
 * - `truncate`: the connection breaks in the middle of the body.
 */
export const RESPONSE_FAULTS = ['none', 'drop-response', 'bad-gateway', 'truncate'] as const;
export type ResponseFault = (typeof RESPONSE_FAULTS)[number];

/** `responses-lost` is a one-way partition: requests reach the server, answers never come back. */
export const LINK_STATES = ['up', 'down', 'responses-lost'] as const;
export type LinkState = (typeof LINK_STATES)[number];

/** What the network did, for the trace. Only semantic facts: no timings, no host-specific text. */
export type NetworkEvent =
  | { kind: 'sent'; client: string; exchange: number; method: string; path: string; body: string | undefined }
  | { kind: 'delivered'; client: string; exchange: number; fault: RequestFault; responses: Answer[] }
  | { kind: 'answered'; client: string; exchange: number; fault: ResponseFault; status: number | 'error' }
  | { kind: 'redelivered'; client: string; exchange: number; responses: Answer[] }
  | { kind: 'link'; client: string; state: LinkState };

/** A server answer as recorded in the trace: status, body digest and the server-side errors. */
export interface Answer {
  status: number;
  body: string;
  errors: string[];
}

type ExchangeState = 'queued' | 'answered' | 'hung';

interface Exchange {
  id: number;
  client: string;
  request: SimRequest;
  state: ExchangeState;
  response?: SimResponse;
  resolve(response: Response): void;
  reject(error: Error): void;
}

/** What `fetch` rejects with when a connection fails (Node's undici does the same). */
function connectionError(reason: string): TypeError {
  return new TypeError('fetch failed', { cause: new Error(reason) });
}

function toRequest(input: RequestInfo | URL, init: RequestInit | undefined): SimRequest {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('SimNetwork accepts a URL string or URL object, as HttpTransport passes');
  }
  const url = new URL(input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    throw new TypeError('SimNetwork accepts string bodies only, as HttpTransport sends');
  }
  return {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: `${url.pathname}${url.search}`,
    headers,
    body: init?.body ?? undefined,
  };
}

function toResponse(response: SimResponse, body = response.body): Response {
  const headers = response.contentType ? { 'content-type': response.contentType } : undefined;
  // A null-body status (204, 304) must not carry a body.
  const nullBody = response.status === 204 || response.status === 304;
  return new Response(nullBody ? null : body, { status: response.status, headers });
}

function answer(response: SimResponse): Answer {
  return {
    status: response.status,
    body: response.body,
    errors: response.serverErrors.map((e) => (e.code ? `${e.name}(${e.code})` : e.name)),
  };
}

/**
 * The network between the simulated clients and the server. Each client gets a `fetch` function
 * ({@link fetchFor}) for the production `HttpTransport`; a request it makes waits in the network
 * until the scheduler delivers it, and the answer waits again until the scheduler hands it back.
 * Faults are chosen by the scheduler per delivery, so the network itself holds no randomness.
 */
export class SimNetwork {
  private nextExchange = 1;
  private readonly exchanges: Exchange[] = [];
  /** Copies of delivered requests that will arrive at the server once more (stale retransmissions). */
  private readonly held: Array<{ client: string; exchange: number; request: SimRequest }> = [];
  private readonly links = new Map<string, LinkState>();

  constructor(
    private readonly server: SimServer,
    private readonly record: (event: NetworkEvent) => void,
  ) {}

  /** A `fetch` for one client. Requests go nowhere until the scheduler delivers them. */
  fetchFor(client: string): typeof fetch {
    this.links.set(client, 'up');
    return (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const request = toRequest(input, init);
        const exchange: Exchange = { id: this.nextExchange, client, request, state: 'queued', resolve, reject };
        this.nextExchange += 1;
        this.exchanges.push(exchange);
        this.record({
          kind: 'sent',
          client,
          exchange: exchange.id,
          method: request.method,
          path: request.path,
          body: request.body,
        });
      });
  }

  linkState(client: string): LinkState {
    return this.links.get(client) ?? 'up';
  }

  setLink(client: string, state: LinkState): void {
    if (this.linkState(client) === state) return;
    this.links.set(client, state);
    this.record({ kind: 'link', client, state });
  }

  /** Clients that have a request waiting to be delivered. */
  queuedClients(): string[] {
    return this.uniqueClients((e) => e.state === 'queued');
  }

  /** Clients that have an answer waiting to be handed back. */
  answeredClients(): string[] {
    return this.uniqueClients((e) => e.state === 'answered');
  }

  /** Clients with a stale copy of a request waiting to arrive again. */
  heldClients(): string[] {
    return [...new Set(this.held.map((h) => h.client))];
  }

  /** Clients waiting on a request that will never be answered. */
  hungClients(): string[] {
    return this.uniqueClients((e) => e.state === 'hung');
  }

  /** True when nothing is in transit (hung requests excepted: they never complete). */
  get idle(): boolean {
    return this.exchanges.every((e) => e.state === 'hung') && this.held.length === 0;
  }

  /** Delivers the oldest queued request of `client` to the server, applying `fault`. */
  async deliver(client: string, fault: RequestFault): Promise<void> {
    const exchange = this.exchanges.find((e) => e.client === client && e.state === 'queued');
    if (!exchange) throw new Error(`no queued request for ${client}`);
    const effective: RequestFault = this.linkState(client) === 'down' ? 'drop-request' : fault;
    const responses: Answer[] = [];
    switch (effective) {
      case 'drop-request':
        this.remove(exchange);
        exchange.reject(connectionError('connection refused (simulated)'));
        break;
      case 'none':
      case 'hang':
      case 'hold-copy': {
        const response = await this.server.send(exchange.request);
        responses.push(answer(response));
        exchange.response = response;
        exchange.state = effective === 'hang' ? 'hung' : 'answered';
        if (effective === 'hold-copy') this.held.push({ client, exchange: exchange.id, request: exchange.request });
        break;
      }
      case 'cut-request': {
        const body = exchange.request.body;
        if (body !== undefined && body.length > 0) {
          const response = await this.server.send({
            ...exchange.request,
            body: body.slice(0, Math.floor(body.length / 2)),
          });
          responses.push(answer(response));
        }
        this.remove(exchange);
        exchange.reject(connectionError('connection reset while sending (simulated)'));
        break;
      }
      case 'duplicate': {
        const first = await this.server.send(exchange.request);
        const second = await this.server.send(exchange.request);
        responses.push(answer(first), answer(second));
        exchange.response = second;
        exchange.state = 'answered';
        break;
      }
    }
    this.record({ kind: 'delivered', client, exchange: exchange.id, fault: effective, responses });
  }

  /** Hands the oldest answer of `client` back to it, applying `fault`. */
  respond(client: string, fault: ResponseFault): void {
    const exchange = this.exchanges.find((e) => e.client === client && e.state === 'answered');
    if (!exchange?.response) throw new Error(`no answer waiting for ${client}`);
    const link = this.linkState(client);
    const effective: ResponseFault = link === 'up' ? fault : 'drop-response';
    const response = exchange.response;
    this.remove(exchange);
    let status: number | 'error' = response.status;
    switch (effective) {
      case 'none':
        exchange.resolve(toResponse(response));
        break;
      case 'drop-response':
        status = 'error';
        exchange.reject(connectionError('connection reset (simulated)'));
        break;
      case 'bad-gateway':
        status = 502;
        exchange.resolve(new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }));
        break;
      case 'truncate':
        exchange.resolve(toResponse(response, response.body.slice(0, Math.floor(response.body.length / 2))));
        break;
    }
    this.record({ kind: 'answered', client, exchange: exchange.id, fault: effective, status });
  }

  /** Delivers the oldest stale copy held for `client` again; its answer reaches no one. */
  async redeliver(client: string): Promise<void> {
    const index = this.held.findIndex((h) => h.client === client);
    const copy = this.held[index];
    if (!copy) throw new Error(`no held copy for ${client}`);
    this.held.splice(index, 1);
    const response = await this.server.send(copy.request);
    this.record({ kind: 'redelivered', client, exchange: copy.exchange, responses: [answer(response)] });
  }

  private remove(exchange: Exchange): void {
    this.exchanges.splice(this.exchanges.indexOf(exchange), 1);
  }

  private uniqueClients(match: (e: Exchange) => boolean): string[] {
    return [...new Set(this.exchanges.filter(match).map((e) => e.client))];
  }
}
