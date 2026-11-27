import { randomUUID } from 'node:crypto';
import {
  asClientId,
  HttpTransport,
  MemoryStorage,
  SyncClient,
  type StreamEvent,
  type Transport,
} from '@fieldsync/sync-core';
import { Pool } from 'pg';
import { StreamService } from '../../src/stream.service';
import { startApp, type RunningApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { Fixtures, type TestUser } from '../support/fixtures';
import { describeWithDb } from '../support/integration';
import { eventually, listenOnLoopback, openStream, type OpenStream } from '../support/stream';

/** Short, so that a few of them show a stream alive while nothing else arrives on it. */
const HEARTBEAT_MS = 1_000;

const count = (text: string, event: string) => text.split(`event: ${event}\n`).length - 1;

/**
 * Two server instances on one database. Each notifies only the streams it holds (fanning pokes out
 * across instances is not built, see README 3.3.3): a client whose stream is on another instance than
 * the one that applied a change gets no poke for it, and has the change from its next sync on.
 */
describeWithDb('two server instances on one database', () => {
  let database: TestDatabase;
  let pool: Pool;
  let first: RunningApp;
  let second: RunningApp;
  let firstPort: number;
  let secondPort: number;
  let site: string;
  let reader: TestUser;
  let writer: TestUser;
  const clients: SyncClient[] = [];
  const streams: OpenStream[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ connectionString: database.url, max: 2 });
    const fixtures = new Fixtures(pool);
    site = await fixtures.site();
    reader = await fixtures.technician(site);
    writer = await fixtures.technician(site);
    const env = { STREAM_HEARTBEAT_MS: String(HEARTBEAT_MS) };
    first = await startApp(database.url, env);
    second = await startApp(database.url, env);
    firstPort = await listenOnLoopback(first.app);
    secondPort = await listenOnLoopback(second.app);
  });

  afterAll(async () => {
    for (const client of clients) client.dispose();
    for (const stream of streams) stream.close();
    await first?.close();
    await second?.close();
    await pool?.end();
    await database?.drop();
  });

  function client(user: TestUser, port: number, options: { live: boolean; events?: StreamEvent['type'][] }) {
    const http = new HttpTransport(`http://127.0.0.1:${port}`, user.token);
    // The client's own transport, with a note of every event its stream delivered to it.
    const transport: Transport = {
      push: (req, init) => http.push(req, init),
      pull: (cursor, clientId, limit, init) => http.pull(cursor, clientId, limit, init),
      snapshot: (req, init) => http.snapshot(req, init),
      stream: (onEvent, init) =>
        http.stream((event) => {
          onEvent(event);
          options.events?.push(event.type);
        }, init),
    };
    const created = new SyncClient({
      clientId: asClientId(randomUUID()),
      transport,
      storage: new MemoryStorage(),
      live: options.live,
    });
    clients.push(created);
    return created;
  }

  async function createTicket(by: SyncClient, title: string): Promise<void> {
    await by.mutate('ticket.create', { id: randomUUID(), siteId: site, title, description: '' });
    await by.sync();
    expect({ status: by.status, pending: by.pendingCount }).toEqual({ status: 'idle', pending: 0 });
  }

  const titles = (of: SyncClient) => of.rows('ticket').map((row) => row.title);

  it('pokes only the streams of the instance that applied a change; the others have it from their next sync', async () => {
    const events: StreamEvent['type'][] = [];
    const a = client(reader, firstPort, { live: true, events });
    // `ready` makes the client sync; a sync asked for after it ends with all of that done.
    expect(await eventually(() => events.includes('ready'), 5_000)).toBe(true);
    await a.sync();
    expect(a.status).toBe('idle');

    // The same user's stream on the other instance: the control that the push below does notify.
    const control = await openStream(secondPort, { authorization: `Bearer ${reader.token}` });
    streams.push(control);
    expect(await eventually(() => second.app.get(StreamService).count === 1, 2_000)).toBe(true);

    const before = events.length;
    await createTicket(client(writer, secondPort, { live: false }), 'Written through the second instance');
    expect(await eventually(() => count(control.text(), 'poke') === 1, 2_000)).toBe(true);

    // Two heartbeats later A's stream has delivered events for longer than a heartbeat interval,
    // far longer than a poke takes (it goes out as soon as the change commits): none came.
    const since = () => events.slice(before);
    expect(await eventually(() => since().filter((e) => e === 'heartbeat').length >= 2, 5_000)).toBe(true);
    expect(since()).not.toContain('poke');
    expect(titles(a)).toEqual([]);

    // Nothing is lost: A's next sync pulls the change from the database both instances share.
    await a.sync();
    expect(titles(a)).toEqual(['Written through the second instance']);

    // A change applied by A's own instance pokes A, which syncs without being asked.
    await createTicket(client(writer, firstPort, { live: false }), 'Written through the first instance');
    expect(await eventually(() => titles(a).length === 2, 5_000)).toBe(true);
    expect(since()).toContain('poke');
    // That poke came from the first instance: the second one's control stream had no second poke.
    expect(count(control.text(), 'poke')).toBe(1);
  }, 20_000);
});
