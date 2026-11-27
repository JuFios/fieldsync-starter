import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { describeWithDb, TEST_APPLICATION_NAME, useIntegration } from '../support/integration';

const SERVER_DIR = join(__dirname, '../..');
const SYNC_CORE_DIR = join(SERVER_DIR, '../../packages/sync-core');

/** Compiles a package with its build configuration; a failure carries the compiler's output. */
async function build(dir: string): Promise<void> {
  try {
    await promisify(execFile)(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
      cwd: dir,
    });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    throw new Error(`building ${dir} failed:\n${stdout ?? ''}${stderr ?? ''}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

/**
 * Experiment: the server process dies (SIGKILL, no shutdown hooks) in the middle of a mutation's
 * transaction, after it wrote the entity and while it waits for the change log's head. Expected: no
 * trace of the mutation anywhere, and the same mutation is applied normally afterwards.
 */
describeWithDb('a server process killed in the middle of a mutation', () => {
  const ctx = useIntegration();
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    // The real entry point, built from the current sources. The server compiles against, and at
    // run time loads, the built sync-core package, so that is built first (a fresh checkout has none).
    await build(SYNC_CORE_DIR);
    await build(SERVER_DIR);
  }, 180_000);

  afterEach(() => {
    child?.kill('SIGCONT');
    child?.kill('SIGKILL');
  });

  async function startServer(env: Record<string, string> = {}): Promise<string> {
    const port = await freePort();
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: ctx.database.url,
        PORT: String(port),
        SEED_DEMO: 'false',
        // Long enough that the transaction is still waiting when the process is killed.
        DB_LOCK_TIMEOUT_MS: '60000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const server = child;
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('listening on')) resolve();
      };
      server.stdout?.on('data', onData);
      server.stderr?.on('data', onData);
      server.once('exit', (code) => reject(new Error(`the server exited with ${code}: ${output}`)));
    });
    return `http://127.0.0.1:${port}`;
  }

  async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('leaves no trace of the mutation, and the client can push it again', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    const setup = await ctx.api.post<PushResponse>(
      '/sync/push',
      {
        clientId: randomUUID(),
        mutations: [
          { id: 1, name: 'ticket.create', args: { id: ticket, siteId: site, title: 'Pump', description: '' } },
        ],
      },
      tech.token,
    );
    precondition(setup.status === 201, `setup answered ${setup.status}`);
    const snapshot = async () => {
      const q = async (sql: string, params: unknown[] = []) =>
        (await ctx.db.query<Record<string, unknown>>(sql, params)).rows;
      return {
        ticket: await q(`SELECT data->>'title' AS title, version FROM entities WHERE id = $1`, [ticket]),
        head: await q(`SELECT version FROM log_head`),
        log: await q(`SELECT count(*) AS n FROM change_log`),
        results: await q(`SELECT count(*) AS n FROM mutation_results`),
        clients: await q(`SELECT count(*) AS n FROM clients`),
      };
    };
    const before = await snapshot();
    const url = await startServer();

    const holder = await ctx.db.connect();
    const clientId = randomUUID();
    const edit = { id: 1, name: 'ticket.update', args: { id: ticket, siteId: site, title: 'Main pump' } };
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE log_head SET version = version WHERE id = 1');
      void fetch(`${url}/sync/push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tech.token}`,
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body: JSON.stringify({ clientId, mutations: [edit] }),
      }).catch(() => undefined);
      // The server's transaction has locked the client and written the ticket, and waits for the head.
      await waitFor(async () => {
        const { rowCount } = await ctx.db.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name <> $1
              AND wait_event_type = 'Lock' AND query LIKE '%log_head%'`,
          [TEST_APPLICATION_NAME],
        );
        return (rowCount ?? 0) > 0;
      }, 'the server to wait for the log head');

      const killed = child as ChildProcess;
      const exited = new Promise((r) => killed.once('exit', r));
      killed.kill('SIGKILL');
      await exited;
    } finally {
      // A session waiting for a lock does not read from its client: it notices the dead process only
      // once it gets the lock (or its lock_timeout expires), then ends and rolls back.
      await holder.query('ROLLBACK');
      holder.release();
    }
    await waitFor(async () => {
      const { rowCount } = await ctx.db.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'fieldsync-server'
            AND state <> 'idle'`,
      );
      return (rowCount ?? 0) === 0;
    }, 'the killed server session to end');

    expect(await snapshot()).toEqual(before);
    const again = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations: [edit] }, tech.token);
    expect(again.body.results?.[0]?.status).toBe('applied');
  }, 60_000);

  /** Appends log entries written 30 days ago, with versions from the head, and returns the first version. */
  async function oldEntries(n: number): Promise<number> {
    const site = await ctx.fixtures.site();
    // Collect what earlier tests left, so that these entries are the oldest part of the log.
    await ctx.db.query(`DELETE FROM change_log`);
    await ctx.db.query(`UPDATE log_floor SET version = (SELECT version FROM log_head)`);
    const { rows } = await ctx.db.query<{ first: string }>(
      `WITH head AS (UPDATE log_head SET version = version + $2 WHERE id = 1 RETURNING version)
       INSERT INTO change_log (version, site_id, entity, entity_id, op, data, created_at)
       SELECT head.version - $2 + g, $1, 'ticket', gen_random_uuid(), 'put', '{}', now() - interval '30 days'
         FROM head, generate_series(1, $2) g
       RETURNING (SELECT version - $2 + 1 FROM head) AS first`,
      [site, n],
    );
    return Number(rows[0].first);
  }

  const gcState = async () => ({
    floor: (await ctx.db.query<{ version: string }>('SELECT version FROM log_floor')).rows[0].version,
    log: (await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM change_log')).rows[0].n,
  });

  const serverSessions = async (where: string) =>
    (
      await ctx.db.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'fieldsync-server' AND ${where}`,
      )
    ).rowCount ?? 0;

  it('leaves the log and its floor untouched when the server dies in the middle of a GC batch', async () => {
    const first = await oldEntries(50);
    const before = await gcState();
    const holder = await ctx.db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM change_log WHERE version = $1 FOR UPDATE', [first]);
      // The GC runs every second; its first batch stops at the locked row inside its DELETE.
      await startServer({ GC_INTERVAL_MS: '1000' });
      await waitFor(
        async () => (await serverSessions(`wait_event_type = 'Lock' AND query LIKE '%DELETE FROM change_log%'`)) > 0,
        'the GC batch to wait for the locked row',
      );
      const killed = child as ChildProcess;
      const exited = new Promise((r) => killed.once('exit', r));
      killed.kill('SIGKILL');
      await exited;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await waitFor(async () => (await serverSessions(`state <> 'idle'`)) === 0, 'the killed GC session to end');
    expect(await gcState()).toEqual(before);
  }, 60_000);

  it('rolls a GC batch back when the server stops between the batch and its commit', async () => {
    const first = await oldEntries(50);
    const before = await gcState();
    const holder = await ctx.db.connect();
    let stopped: ChildProcess | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM change_log WHERE version = $1 FOR UPDATE', [first]);
      await startServer({ GC_INTERVAL_MS: '1000', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '500' });
      await waitFor(
        async () => (await serverSessions(`wait_event_type = 'Lock' AND query LIKE '%DELETE FROM change_log%'`)) > 0,
        'the GC batch to wait for the locked row',
      );
      // The process freezes (SIGSTOP); once the row is free its statement finishes, and its session
      // sits idle in the transaction, holding the batch's locks, with nobody to commit it.
      if (!child) throw new Error('the server is not running');
      child.kill('SIGSTOP');
      stopped = child;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await waitFor(
      async () => (await serverSessions(`state = 'idle in transaction'`)) > 0,
      'the frozen GC session to sit idle in its transaction',
    );
    // Postgres ends the idle session after idle_in_transaction_session_timeout and rolls it back.
    await waitFor(async () => (await serverSessions(`state LIKE 'idle in transaction%'`)) === 0, 'the session to end');
    expect(await gcState()).toEqual(before);
    stopped?.kill('SIGCONT');
  }, 60_000);
});
