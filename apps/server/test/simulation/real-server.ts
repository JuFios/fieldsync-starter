import { Catch, HttpException, type ArgumentsHost, type INestApplication } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Fixtures, ServerError, SimRequest, SimResponse, SimServer, StoredRow } from '@fieldsync/sim';
import type { EntityName, Row } from '@fieldsync/sync-core';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { Clock } from '../../src/clock';
import { loadConfig } from '../../src/config';

/** The application's own tables, in an order TRUNCATE accepts (it truncates them all at once anyway). */
const TABLES = ['clients', 'change_log', 'entities', 'user_sites', 'users', 'sites'];

/** A Clock whose time source the simulation swaps for each run. */
class SimulatedClock extends Clock {
  source: () => number = () => {
    throw new Error('the simulated clock was read before a run set its time source');
  };

  now(): Date {
    return new Date(this.source());
  }
}

/** Records the class and code of every exception a request raises, then answers like Nest does. */
@Catch()
class RecordingExceptionFilter extends BaseExceptionFilter {
  constructor(
    adapter: HttpAdapterHost['httpAdapter'],
    private readonly sink: (error: ServerError) => void,
  ) {
    super(adapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const name = exception instanceof Error ? exception.constructor.name : typeof exception;
    const code = (exception as { code?: unknown } | null)?.code;
    // HTTP exceptions are deliberate answers (401, 400); only unexpected errors matter for signatures.
    if (!(exception instanceof HttpException)) {
      this.sink(typeof code === 'string' ? { name, code } : { name });
    }
    super.catch(exception, host);
  }
}

/**
 * The real server on a real database, as a {@link SimServer}: the production AppModule with only the
 * Clock replaced, the production app settings, a listener on an ephemeral port and real HTTP. Data
 * is reset between runs with TRUNCATE ... RESTART IDENTITY, so versions start at 1 for every run and
 * the physical row order is the same in every run of a seed.
 */
export class RealServer implements SimServer {
  private errors: ServerError[] = [];

  private constructor(
    private readonly app: INestApplication,
    private readonly url: string,
    private readonly clock: SimulatedClock,
    /** Direct connection for fixtures and the oracle, independent of the server's data layer. */
    private readonly db: Pool,
  ) {}

  static async start(databaseUrl: string): Promise<RealServer> {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      SEED_DEMO: 'false',
      // The simulation drives no GC; keep the timer from firing during a long local search.
      GC_INTERVAL_MS: String(2_147_483_647),
      DB_POOL_MAX: '4',
    });
    const clock = new SimulatedClock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const app = configureApp(moduleRef.createNestApplication({ logger: false, abortOnError: false }));
    // The filter is created before the server object, so it reaches the server through this holder.
    const holder: { server?: RealServer } = {};
    const sink = (error: ServerError) => holder.server?.errors.push(error);
    app.useGlobalFilters(new RecordingExceptionFilter(app.get(HttpAdapterHost).httpAdapter, sink));
    try {
      await app.listen(0, '127.0.0.1');
    } catch (err) {
      await app.close();
      throw err;
    }
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    const db = new Pool({ connectionString: databaseUrl, max: 2, application_name: 'fieldsync-sim' });
    db.on('error', () => undefined);
    const server = new RealServer(app, `http://127.0.0.1:${port}`, clock, db);
    holder.server = server;
    return server;
  }

  async reset(fixtures: Fixtures, now: () => number): Promise<void> {
    this.clock.source = now;
    this.errors = [];
    await this.db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    for (const site of fixtures.sites) {
      await this.db.query('INSERT INTO sites (id, name) VALUES ($1, $2)', [site.id, site.name]);
    }
    for (const user of fixtures.users) {
      await this.db.query('INSERT INTO users (id, name, role, token) VALUES ($1, $2, $3, $4)', [
        user.id,
        user.name,
        user.role,
        user.token,
      ]);
      for (const site of user.sites) {
        await this.db.query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)', [user.id, site]);
      }
    }
  }

  async send(request: SimRequest): Promise<SimResponse> {
    this.errors = [];
    const res = await fetch(`${this.url}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const body = await res.text();
    const serverErrors = this.errors;
    this.errors = [];
    return { status: res.status, contentType: res.headers.get('content-type') ?? undefined, body, serverErrors };
  }

  async liveRows(): Promise<StoredRow[]> {
    const { rows } = await this.db.query<{ entity: EntityName; id: string; site_id: string; data: Row }>(
      `SELECT entity, id, site_id, data FROM entities WHERE NOT deleted ORDER BY entity, id`,
    );
    return rows.map((r) => ({ entity: r.entity, id: r.id, siteId: r.site_id, data: r.data }));
  }

  async close(): Promise<void> {
    await this.db.end();
    await this.app.close();
  }
}
