import { asVersion, MemoryStorage, SyncClient, type PullResponse, type Transport } from '../src';

/**
 * A notification that arrives while a sync is running must lead to another pull: the running one may
 * have read its page before the announced change committed (F-39).
 */
describe('a notification during a sync', () => {
  it('makes the client pull again once the running sync ends', async () => {
    let head = 1;
    let releaseSecondPull: () => void = () => undefined;
    const pulls: number[] = [];
    const transport: Transport = {
      push: () => Promise.reject(new Error('nothing to push')),
      snapshot: () => Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null }),
      pull: async (cursor) => {
        pulls.push(cursor);
        const seen = head; // the page is read now
        if (pulls.length === 2) await new Promise<void>((resolve) => (releaseSecondPull = resolve));
        const page: PullResponse = {
          changes: [],
          nextCursor: asVersion(Math.max(cursor, seen)),
          hasMore: false,
          lastMutationId: 0,
          head: asVersion(seen),
        };
        return page;
      },
    };
    const client = new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
    try {
      await client.sync(); // snapshot, then the log from its watermark (pull 1)
      const running = client.sync(); // pull 2 reads head 1, then waits
      await new Promise((resolve) => setImmediate(resolve));
      head = 2; // a write commits, and the server announces it
      void client.sync();
      releaseSecondPull();
      await running;
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The tail of the first sync, the running pull, and one more for the notification.
      expect(pulls).toEqual([0, 1, 1]);
    } finally {
      client.dispose();
    }
  });
});
