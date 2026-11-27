import {
  asVersion,
  HttpTransport,
  MemoryStorage,
  SyncClient,
  type Persisted,
  type PushRequest,
  type PushResponse,
  type SnapshotPage,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '00000000-0000-4000-8000-000000000001';
const EMPTY: SnapshotPage = { watermark: asVersion(0), head: asVersion(0), rows: [], next: null };

/** Storage that records every save, so a test can see what a disposed client still writes. */
class RecordingStorage extends MemoryStorage {
  readonly saves: Persisted[] = [];

  override save(state: Persisted): Promise<void> {
    this.saves.push(structuredClone(state));
    return super.save(state);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A client that goes away (its page closes, or the user changes) stops all its work (F-37). */
describe('a disposed client', () => {
  it('aborts the request it has in flight', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>(() => undefined);
    };
    const client = new SyncClient({
      clientId: 'c1',
      transport: new HttpTransport('http://server.test', 'token', fetchImpl),
      storage: new MemoryStorage(),
    });
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await settle();
    expect(signals).toHaveLength(1);

    client.dispose();

    expect(signals[0]?.aborted).toBe(true);
  });

  it('writes nothing once disposed, even when an answer arrives afterwards', async () => {
    let answer: (res: PushResponse) => void = () => undefined;
    const transport: Transport = {
      push: (_req: PushRequest) => new Promise<PushResponse>((resolve) => (answer = resolve)),
      pull: () =>
        Promise.resolve({
          changes: [],
          nextCursor: asVersion(0),
          hasMore: false,
          lastMutationId: 1,
          head: asVersion(0),
        }),
      snapshot: () => Promise.resolve(EMPTY),
    };
    const storage = new RecordingStorage();
    const client = new SyncClient({ clientId: 'c1', transport, storage });
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await settle();

    client.dispose();
    answer({ results: [{ id: 1, status: 'applied' }], lastMutationId: 1 });
    await settle();

    expect(storage.saves).toEqual([]);
  });
});
