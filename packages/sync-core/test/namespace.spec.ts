import 'fake-indexeddb/auto';
import { DATABASE_PREFIX, databaseNameFor, deleteSyncDatabases, IdbSyncStorage } from '../src';

describe('databaseNameFor', () => {
  it('gives each token a database of its own, the same every time, without the token in it', async () => {
    const a = await databaseNameFor('tech-a-token');
    const b = await databaseNameFor('tech-b-token');
    expect(a).not.toBe(b);
    await expect(databaseNameFor('tech-a-token')).resolves.toBe(a);
    expect(a).toMatch(new RegExp(`^${DATABASE_PREFIX}[0-9a-f]{64}$`));
    expect(a).not.toContain('tech-a-token');
  });
});

describe('deleteSyncDatabases', () => {
  it("deletes every client database and nothing else, closing other tabs' connections", async () => {
    const mine = await IdbSyncStorage.open(await databaseNameFor('one'));
    const closed: string[] = [];
    await IdbSyncStorage.open(await databaseNameFor('two'), { onClosed: (r) => closed.push(r) });
    mine.close();
    const other = indexedDB.open('another-app');
    await new Promise((resolve) => (other.onsuccess = resolve));
    other.result.close();

    await deleteSyncDatabases();

    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names.filter((n) => n?.startsWith(DATABASE_PREFIX))).toEqual([]);
    expect(names).toContain('another-app');
    expect(closed).toEqual(['deleted']);
  });
});
