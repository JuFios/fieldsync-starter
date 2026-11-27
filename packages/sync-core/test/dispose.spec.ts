import {
  asVersion,
  HttpTransport,
  MemoryStorage,
  SyncClient,
  type StateChange,
  type PushRequest,
  type PushResponse,
  type SnapshotPage,
  type Transport,
  asMutationId,
} from '../src';
import { CLIENT_ID } from './support/ids';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '00000000-0000-4000-8000-000000000001';
const EMPTY: SnapshotPage = { watermark: asVersion(0), head: asVersion(0), rows: [], next: null };

/** Storage that records every write, so a test can see what a disposed client still writes. */
class RecordingStorage extends MemoryStorage {
  readonly saves: StateChange[] = [];

  override commit(change: StateChange): Promise<void> {
    this.saves.push(structuredClone(change));
    return super.commit(change);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A client that goes away (its page closes, or the user changes) stops all its work (F-37). */
describe('a disposed client', () => {
  it('aborts every request it has in flight', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>(() => undefined);
    };
    const client = new SyncClient({
      clientId: CLIENT_ID,
      transport: new HttpTransport('http://server.test', 'token', fetchImpl),
      storage: new MemoryStorage(),
    });
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await settle();
    // The push, and the notification stream the client keeps open.
    expect(signals).toHaveLength(2);

    client.dispose();

    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true]);
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
          lastMutationId: asMutationId(1),
          head: asVersion(0),
        }),
      snapshot: () => Promise.resolve(EMPTY),
    };
    const storage = new RecordingStorage();
    const client = new SyncClient({ clientId: CLIENT_ID, transport, storage });
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await settle();

    client.dispose();
    answer({ results: [{ id: asMutationId(1), status: 'applied' }], lastMutationId: asMutationId(1) });
    await settle();

    expect(storage.saves).toEqual([]);
  });
});
