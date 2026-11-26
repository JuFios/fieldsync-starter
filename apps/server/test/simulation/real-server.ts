import { Catch, HttpException, type ArgumentsHost, type INestApplication } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Fixtures, ServerError, SimRequest, SimResponse, SimServer, StoredRow } from '@fieldsync/sim';
import type { EntityName, Row } from '@fieldsync/sync-core';
import { Agent, type Server } from 'node:http';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { Clock } from '../../src/clock';

/** The application's own tables, in an order TRUNCATE accepts (it truncates them all at once anyway). */
const TABLES = ['clients', 'change_log', 'entities', 'user_sites', 'users', 'sites'];

/** The supertest method for an HTTP method of the sync client (it sends GET and POST only). */
function methodOf(method: string): 'get' | 'post' {
  const lower = method.toLowerCase();
  if (lower !== 'get' && lower !== 'post') throw new Error(`the simulation does not send ${method} requests`);
  return lower;
}

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
 * Clock replaced and the production app settings, called over real HTTP through supertest. Data
 * is reset between runs with TRUNCATE ... RESTART IDENTITY, so versions start at 1 for every run and
 * the physical row order is the same in every run of a seed.
 */
export class RealServer implements SimServer {
  private errors: ServerError[] = [];

  private constructor(
    private readonly app: INestApplication,
    /** The application's HTTP server, for tests of the binding itself. */
    readonly httpServer: Server,
    private readonly clock: SimulatedClock,
    /** Direct connection for fixtures and the oracle, independent of the server's data layer. */
    private readonly db: Pool,
  ) {}

  /**
   * One kept-alive connection for every request. superagent's default (`agent: false`) opens a
   * connection per request, and each closed one waits in TIME_WAIT (30 s on macOS): a long search
   * would run out of ephemeral ports. Requests are sequential, so one socket is enough.
   */
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 });

  static async start(databaseUrl: string): Promise<RealServer> {
    const env = {
      DATABASE_URL: databaseUrl,
      SEED_DEMO: 'false',
      // The simulation drives no GC; keep the timer from firing during a long local search.
      GC_INTERVAL_MS: String(2_147_483_647),
      DB_POOL_MAX: '4',
    };
    const clock = new SimulatedClock();
    const moduleRef = await Test.createTestingModule({ imports: [await AppModule.forRoot(env)] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const app = configureApp(moduleRef.createNestApplication({ logger: false, abortOnError: false }));
    // The filter is created before the server object, so it reaches the server through this holder.
    const holder: { server?: RealServer } = {};
    const sink = (error: ServerError) => holder.server?.errors.push(error);
    app.useGlobalFilters(new RecordingExceptionFilter(app.get(HttpAdapterHost).httpAdapter, sink));
    // The binding's own client is the only one, and it keeps one connection alive between requests.
    // Without this, Node closes that connection after keepAliveTimeout of idleness, and a request sent
    // as it closes fails with ECONNRESET. 0 disables the timeout (Node's http.Server documentation).
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
    try {
      // Listening once keeps the server under our control: supertest binds a server that is not
      // listening to a new ephemeral port for every request and closes it afterwards.
      await app.listen(0, '127.0.0.1');
    } catch (err) {
      await app.close();
      throw err;
    }
    const db = new Pool({ connectionString: databaseUrl, max: 2, application_name: 'fieldsync-sim' });
    db.on('error', () => undefined);
    const server = new RealServer(app, app.getHttpServer() as Server, clock, db);
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

  async send(simRequest: SimRequest): Promise<SimResponse> {
    this.errors = [];
    const client = request(this.httpServer);
    const res = await client[methodOf(simRequest.method)](simRequest.path)
      .agent(this.agent)
      .set(simRequest.headers)
      // Every status is an answer for the simulation, not an error of the request.
      .ok(() => true)
      .send(simRequest.body);
    const serverErrors = this.errors;
    this.errors = [];
    const contentType = res.headers['content-type'] as string | undefined;
    return { status: res.status, contentType, body: res.text, serverErrors };
  }

  async liveRows(): Promise<StoredRow[]> {
    const { rows } = await this.db.query<{ entity: EntityName; id: string; site_id: string; data: Row }>(
      `SELECT entity, id, site_id, data FROM entities WHERE NOT deleted ORDER BY entity, id`,
    );
    return rows.map((r) => ({ entity: r.entity, id: r.id, siteId: r.site_id, data: r.data }));
  }

  async close(): Promise<void> {
    this.agent.destroy();
    await this.db.end();
    await this.app.close();
  }
}
