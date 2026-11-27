import {
  asVersion,
  HttpTransport,
  MemoryStorage,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SyncClient,
  TransportError,
  type PullResponse,
  type RequestOptions,
  type StreamEvent,
  type Transport,
} from '../src';
import { ManualClock } from './support/manual-clock';
import { CLIENT_ID } from './support/ids';

const settle = () => new Promise((r) => setImmediate(r));

/** One open stream of the scripted transport: the test sends events into it or ends it. */
interface OpenStream {
  emit(event: StreamEvent): void;
  end(): void;
  fail(err: Error): void;
  signal: AbortSignal | undefined;
}

/** A server with an empty log and a stream the test drives. */
class StreamingTransport implements Transport {
  readonly streams: OpenStream[] = [];
  pulls = 0;

  push(): Promise<never> {
    return Promise.reject(new Error('nothing to push'));
  }

  pull(cursor: number): Promise<PullResponse> {
    this.pulls += 1;
    return Promise.resolve({
      changes: [],
      nextCursor: asVersion(cursor),
      hasMore: false,
      lastMutationId: 0,
      head: asVersion(cursor),
    });
  }

  snapshot() {
    return Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null });
  }

  stream(onEvent: (event: StreamEvent) => void, init?: RequestOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      this.streams.push({ emit: onEvent, end: resolve, fail: reject, signal: init?.signal });
    });
  }

  get open(): OpenStream {
    const last = this.streams.at(-1);
    if (!last) throw new Error('no stream was opened');
    return last;
  }
}

const clients: SyncClient[] = [];
function client(transport: Transport, clock: ManualClock) {
  // Delays just below the ceiling: 999 ms, then 1998 ms, ...
  const c = new SyncClient({
    clientId: CLIENT_ID,
    transport,
    storage: new MemoryStorage(),
    clock,
    random: () => 0.999,
  });
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

describe('the notification stream of a client', () => {
  it('opens once the client is ready, syncs when it opens and on every poke', async () => {
    const t = new StreamingTransport();
    const c = client(t, new ManualClock());
    await c.ready;
    expect(t.streams).toHaveLength(1);
    t.open.emit({ type: 'ready', heartbeatMs: 15_000 });
    await settle();
    const afterReady = t.pulls;
    expect(afterReady).toBeGreaterThan(0);
    t.open.emit({ type: 'poke' });
    await settle();
    expect(t.pulls).toBeGreaterThan(afterReady);
  });

  it('takes a stream silent for three heartbeats for dead, and opens a new one after a backoff', async () => {
    const clock = new ManualClock();
    const t = new StreamingTransport();
    const c = client(t, clock);
    await c.ready;
    t.open.emit({ type: 'ready', heartbeatMs: 1_000 });
    await clock.advance(2_999);
    t.open.emit({ type: 'heartbeat' });
    await clock.advance(2_999);
    expect(t.open.signal?.aborted).toBe(false);
    await clock.advance(1);
    expect(t.streams[0]?.signal?.aborted).toBe(true);
    await clock.advance(998);
    expect(t.streams).toHaveLength(1);
    await clock.advance(1);
    expect(t.streams).toHaveLength(2);
  });

  it('reopens an ended stream with growing delays, and starts over once one opens', async () => {
    const clock = new ManualClock();
    const t = new StreamingTransport();
    const c = client(t, clock);
    await c.ready;
    t.open.end();
    await settle();
    await clock.advance(999);
    expect(t.streams).toHaveLength(2);
    t.open.fail(new Error('connection reset'));
    await settle();
    await clock.advance(1_997);
    expect(t.streams).toHaveLength(2);
    await clock.advance(1);
    expect(t.streams).toHaveLength(3);
    t.open.emit({ type: 'ready', heartbeatMs: 15_000 });
    t.open.end();
    await settle();
    await clock.advance(999);
    expect(t.streams).toHaveLength(4);
  });

  it('stops for good when the server says the client must be updated', async () => {
    const clock = new ManualClock();
    const t = new StreamingTransport();
    const c = client(t, clock);
    await c.ready;
    t.open.fail(new TransportError(400, 'CLIENT_UPDATE_REQUIRED', 'update', { min: 2, max: 2 }));
    await settle();
    await clock.advance(10 * 60_000);
    expect(t.streams).toHaveLength(1);
  });

  it('leaves no timer and no open stream once disposed', async () => {
    const clock = new ManualClock();
    const t = new StreamingTransport();
    const c = client(t, clock);
    await c.ready;
    t.open.emit({ type: 'ready', heartbeatMs: 15_000 });
    await settle();
    c.dispose();
    await settle();
    expect(t.open.signal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    await clock.advance(10 * 60_000);
    expect(t.streams).toHaveLength(1);
  });

  it('leaves no listener behind after reconnecting many times', async () => {
    // Abort listeners per signal, added minus removed (a once listener that fired counts as removed).
    const live = new Map<EventTarget, Set<unknown>>();
    // Kept to be called with Reflect.apply and its own `this`, and put back afterwards.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalAdd = EventTarget.prototype.addEventListener;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: unknown,
      options?: unknown,
    ) {
      if (type === 'abort' && this instanceof AbortSignal) {
        const set = live.get(this) ?? new Set();
        set.add(listener);
        live.set(this, set);
      }
      return Reflect.apply(originalAdd, this, [type, listener, options]) as void;
    };
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: unknown,
      options?: unknown,
    ) {
      if (type === 'abort') live.get(this)?.delete(listener);
      return Reflect.apply(originalRemove, this, [type, listener, options]) as void;
    };
    try {
      const clock = new ManualClock();
      const t = new StreamingTransport();
      const c = client(t, clock);
      await c.ready;
      for (let i = 0; i < 30; i += 1) {
        t.open.emit({ type: 'ready', heartbeatMs: 15_000 });
        t.open.end();
        await settle();
        await clock.advance(1_000);
      }
      expect(t.streams.length).toBeGreaterThan(30);
      // The client's own signal carries a handful of listeners however often the stream reopened.
      const most = Math.max(...[...live.values()].map((set) => set.size));
      expect(most).toBeLessThan(5);
    } finally {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
    }
  });

  it('opens no stream when the client is not live', async () => {
    const t = new StreamingTransport();
    const c = new SyncClient({ clientId: CLIENT_ID, transport: t, storage: new MemoryStorage(), live: false });
    clients.push(c);
    await c.ready;
    expect(t.streams).toHaveLength(0);
  });
});

describe('HttpTransport.stream', () => {
  const sse = (text: string, init: ResponseInit = {}) =>
    new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });

  it('sends the token and the protocol version in headers, and parses the events', async () => {
    let headers: Headers | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      headers = new Headers(init?.headers);
      return Promise.resolve(
        sse(
          '\nevent: ready\nid: 1\ndata: {"heartbeatMs":15000}\n\nevent: poke\ndata: {}\n\nevent: heartbeat\ndata: {}\n\nevent: other\ndata: x\n\n',
        ),
      );
    };
    const events: StreamEvent[] = [];
    await new HttpTransport('http://server.test', 'secret', fetchImpl).stream((e) => events.push(e));
    expect(events).toEqual([{ type: 'ready', heartbeatMs: 15_000 }, { type: 'poke' }, { type: 'heartbeat' }]);
    expect(headers?.get('authorization')).toBe('Bearer secret');
    expect(headers?.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
  });

  it('rejects with the problem of an error answer', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 'CLIENT_UPDATE_REQUIRED', detail: 'update', details: { min: 2, max: 2 } }),
          {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      );
    await expect(new HttpTransport('http://s', 't', fetchImpl).stream(() => undefined)).rejects.toMatchObject({
      status: 400,
      code: 'CLIENT_UPDATE_REQUIRED',
    });
  });

  it('rejects an answer that is not an event stream', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(new HttpTransport('http://s', 't', fetchImpl).stream(() => undefined)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });
});
