import {
  asVersion,
  MemoryStorage,
  SyncClient,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SnapshotPage,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';

/** The most bytes one push body may have; the server accepts at least this much (see the README). */
const MAX_PUSH_BODY_BYTES = 1_048_576;

/** Fails while offline; once online, applies every pushed mutation and records each body's size. */
class RecordingTransport implements Transport {
  online = false;
  readonly bodies: Array<{ bytes: number; ids: number[] }> = [];

  push(req: PushRequest): Promise<PushResponse> {
    if (!this.online) return Promise.reject(new Error('offline'));
    this.bodies.push({
      bytes: new TextEncoder().encode(JSON.stringify(req)).length,
      ids: req.mutations.map((m) => m.id),
    });
    const last = req.mutations.at(-1)?.id ?? 0;
    return Promise.resolve({
      results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
      lastMutationId: last,
    });
  }

  pull(): Promise<PullResponse> {
    if (!this.online) return Promise.reject(new Error('offline'));
    return Promise.resolve({ changes: [], nextCursor: asVersion(0), hasMore: false, lastMutationId: 0 });
  }

  snapshot(): Promise<SnapshotPage> {
    if (!this.online) return Promise.reject(new Error('offline'));
    return Promise.resolve({ watermark: asVersion(0), rows: [], next: null });
  }
}

function ticketId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe('push batches', () => {
  it('splits a queue of long mutations into bodies the server accepts, in order', async () => {
    const transport = new RecordingTransport();
    const client = new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
    try {
      // A control character takes six bytes in JSON ("\u0001"), so each mutation is about 30 KB.
      for (let n = 1; n <= 100; n += 1) {
        client.mutate('ticket.create', {
          id: ticketId(n),
          siteId: SITE,
          title: 'T',
          description: '\u0001'.repeat(5000),
        });
      }
      await client.sync();
      transport.online = true;
      while (client.pendingCount > 0) await client.sync();
      expect(Math.max(...transport.bodies.map((b) => b.bytes))).toBeLessThanOrEqual(MAX_PUSH_BODY_BYTES);
      expect(transport.bodies.flatMap((b) => b.ids)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    } finally {
      client.dispose();
    }
  });
});

describe('mutate', () => {
  it('refuses a mutation that cannot fit in one push, queueing nothing', () => {
    const transport = new RecordingTransport();
    const client = new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
    try {
      const args = { id: ticketId(1), siteId: SITE, title: 'T', description: '', notes: 'x'.repeat(1_048_576) };
      expect(() => client.mutate('ticket.create', args)).toThrow(TypeError);
      expect(client.pendingCount).toBe(0);
    } finally {
      client.dispose();
    }
  });
});
