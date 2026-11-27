import {
  MUTATORS,
  MutationRejected,
  type EntityName,
  type Mutation,
  type MutationResult,
  type MutatorTx,
  type Row,
} from '@fieldsync/sync-core';
import {
  SIM_RETENTION_MS,
  type Fixtures,
  type ServerError,
  type SimRequest,
  type SimResponse,
  type SimServer,
  type StoredRow,
  type SimUser,
} from '../../src/types';

/**
 * Defects the reference server can be told to have, so the engine's tests can show that the oracle
 * and the liveness check catch them.
 */
export type Defect =
  /** Answers 500 to a push whose mutation the mutator rejects (like the original server). */
  | 'rejection-500'
  /** Incremental pulls ignore the user's sites (like the original server). */
  | 'foreign-rows'
  /** Pull silently leaves out every change of the first row ever written. */
  | 'drop-first-row'
  /** Every push answers 503 without doing anything. */
  | 'push-unavailable'
  /** Pulled tickets carry the status "constructor", which no mutator accepts as a state. */
  | 'corrupt-status'
  /** Rejects every edit of a ticket with INTERNAL instead of applying it. */
  | 'internal-rejection'
  /** An edit that leaves the description out empties it (like the original `ticket.update`). */
  | 'blank-unsent-description'
  /** The GC removes old changes but never raises the floor, so nobody is reset (like the original GC, F-34). */
  | 'compact-without-floor'
  /** Reports no handled mutations to the oracle, as if every queued mutation was dropped by its client. */
  | 'forget-handled';

interface Entity {
  entity: EntityName;
  id: string;
  siteId: string;
  data: Row | null;
  deleted: boolean;
}

interface LogEntry {
  version: number;
  /** Virtual time of the write, for the GC. */
  at: number;
  siteId: string;
  entity: EntityName;
  id: string;
  op: 'put' | 'del';
  data: Row | null;
}

const json = (status: number, body: unknown, serverErrors: ServerError[] = []): SimResponse => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body),
  serverErrors,
});

/**
 * An in-memory implementation of the sync protocol, written independently of the real server and
 * following the intended semantics: per-client mutation ids with duplicate detection, rejections
 * reported per mutation (advancing the client's last mutation id), site-filtered pulls by version.
 */
export class MemoryServer implements SimServer {
  readonly requests: SimRequest[] = [];
  private users = new Map<string, SimUser>();
  private fixtures: Fixtures = { sites: [], users: [] };
  private entities = new Map<string, Entity>();
  private log: LogEntry[] = [];
  /** Highest version the GC removed: the log holds the versions after it, up to `head`. */
  private floor = 0;
  private head = 0;
  /** The first row ever written (for the `drop-first-row` defect), kept when the GC removes its change. */
  private first: { entity: EntityName; id: string } | undefined;
  private lastMutation = new Map<string, number>();
  private now: () => number = () => 0;

  constructor(private readonly defects: ReadonlySet<Defect> = new Set()) {}

  reset(fixtures: Fixtures, now: () => number): Promise<void> {
    this.fixtures = fixtures;
    this.users = new Map(fixtures.users.map((u) => [u.token, u]));
    this.entities = new Map();
    this.log = [];
    this.floor = 0;
    this.head = 0;
    this.first = undefined;
    this.lastMutation = new Map();
    this.requests.length = 0;
    this.now = now;
    return Promise.resolve();
  }

  liveRows(): Promise<StoredRow[]> {
    return Promise.resolve(
      [...this.entities.values()]
        .filter((e) => !e.deleted && e.data)
        .map((e) => ({ entity: e.entity, id: e.id, siteId: e.siteId, data: e.data as Row })),
    );
  }

  /** Removes the oldest changes up to the first one within the retention, as the real GC does. */
  compact(): Promise<number> {
    const cutoff = this.now() - SIM_RETENTION_MS;
    let removed = 0;
    while (this.log[0] && this.log[0].at < cutoff) {
      const gone = this.log.shift() as LogEntry;
      if (!this.defects.has('compact-without-floor')) this.floor = gone.version;
      removed += 1;
    }
    return Promise.resolve(removed);
  }

  handledMutations(): Promise<Map<string, number>> {
    if (this.defects.has('forget-handled')) return Promise.resolve(new Map<string, number>());
    return Promise.resolve(new Map(this.lastMutation));
  }

  private gone(): SimResponse {
    return {
      status: 410,
      contentType: 'application/problem+json',
      body: JSON.stringify({ status: 410, code: 'RESET_REQUIRED', detail: 'reset', details: { floor: this.floor } }),
      serverErrors: [],
    };
  }

  send(request: SimRequest): Promise<SimResponse> {
    this.requests.push(request);
    const user = this.users.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!user) return Promise.resolve(json(401, { message: 'Unauthorized' }));
    const url = new URL(request.path, 'http://memory');
    if (request.method === 'POST' && url.pathname === '/sync/push') {
      return Promise.resolve(
        this.push(user, JSON.parse(request.body ?? '{}') as { clientId: string; mutations: Mutation[] }),
      );
    }
    if (request.method === 'GET' && url.pathname === '/sync/pull')
      return Promise.resolve(this.pull(user, url.searchParams));
    if (request.method === 'GET' && url.pathname === '/sync/snapshot') {
      return Promise.resolve(this.snapshot(user, url.searchParams));
    }
    return Promise.resolve(json(404, { message: 'Not found' }));
  }

  private sites(user: SimUser): Set<string> {
    return new Set(user.role === 'admin' ? this.fixtures.sites.map((s) => s.id) : user.sites);
  }

  private push(user: SimUser, body: { clientId: string; mutations: Mutation[] }): SimResponse {
    if (this.defects.has('push-unavailable')) return json(503, { message: 'Unavailable' });
    const results: MutationResult[] = [];
    for (const m of body.mutations) {
      const last = this.lastMutation.get(body.clientId) ?? 0;
      if (m.id <= last) {
        results.push({ id: m.id, status: 'duplicate' });
        continue;
      }
      if (m.id !== last + 1) return json(400, { message: `Out-of-order mutation ${m.id}` });
      try {
        if (this.defects.has('internal-rejection') && m.name === 'ticket.update') {
          throw new MutationRejected('INTERNAL', 'The server could not apply this mutation');
        }
        const blanks =
          this.defects.has('blank-unsent-description') &&
          m.name === 'ticket.update' &&
          m.args.description === undefined;
        this.apply(user, blanks ? { ...m, args: { ...m.args, description: '' } } : m);
        results.push({ id: m.id, status: 'applied' });
      } catch (err) {
        if (!(err instanceof MutationRejected)) throw err;
        if (this.defects.has('rejection-500')) {
          return json(500, { message: 'Internal server error' }, [{ name: 'MutationRejected', code: err.code }]);
        }
        results.push({ id: m.id, status: 'rejected', code: err.code, message: err.message, details: err.details });
      }
      this.lastMutation.set(body.clientId, m.id);
    }
    return json(201, { results, lastMutationId: this.lastMutation.get(body.clientId) ?? 0 });
  }

  /** Applies one mutation atomically: its writes are buffered and committed only if it succeeds. */
  private apply(user: SimUser, m: Mutation): void {
    const def = Object.hasOwn(MUTATORS, m.name) ? MUTATORS[m.name] : undefined;
    if (!def) throw new MutationRejected('UNKNOWN_MUTATOR');
    const sites = this.sites(user);
    const target = (entity: EntityName, id: string) => this.entities.get(`${entity}/${id}`);
    // Write access by the stored row's site, and by the target site for new rows.
    const allowed = (siteId: unknown) => typeof siteId === 'string' && sites.has(siteId);
    const writes: Array<{ op: 'put' | 'insert' | 'del'; entity: EntityName; id: string; row?: Row }> = [];
    const buffer = new Map<string, Row | undefined>();
    const visible = (entity: EntityName, id: string): Row | undefined => {
      const key = `${entity}/${id}`;
      if (buffer.has(key)) return buffer.get(key);
      const stored = target(entity, id);
      return stored && !stored.deleted && allowed(stored.siteId) ? (stored.data ?? undefined) : undefined;
    };
    const time = new Date(this.now()).toISOString();
    const tx: MutatorTx = {
      now: () => time,
      get: visible,
      put: (entity, id, row) => {
        if (!allowed(row.siteId)) throw new MutationRejected('FORBIDDEN');
        buffer.set(`${entity}/${id}`, row);
        writes.push({ op: 'put', entity, id, row });
      },
      insert: (entity, id, row) => {
        if (target(entity, id) || buffer.get(`${entity}/${id}`)) throw new MutationRejected('ID_CONFLICT');
        if (!allowed(row.siteId)) throw new MutationRejected('FORBIDDEN');
        buffer.set(`${entity}/${id}`, row);
        writes.push({ op: 'insert', entity, id, row });
      },
      del: (entity, id) => {
        buffer.set(`${entity}/${id}`, undefined);
        writes.push({ op: 'del', entity, id });
      },
      partsOf: (ticketId) =>
        [...this.entities.values()]
          .filter((e) => e.entity === 'part' && e.data?.ticketId === ticketId)
          .map((e) => visible('part', e.id))
          .filter((row): row is Row => row !== undefined)
          .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)),
    };
    if (!allowed(m.args.siteId)) throw new MutationRejected('FORBIDDEN');
    def.apply(tx, m.args);
    for (const w of writes) {
      const key = `${w.entity}/${w.id}`;
      const siteId = w.row ? (w.row.siteId as string) : (target(w.entity, w.id)?.siteId ?? '');
      const version = (this.head += 1);
      this.first ??= { entity: w.entity, id: w.id };
      const op = w.op === 'del' ? 'del' : 'put';
      const data = w.row ? (JSON.parse(JSON.stringify(w.row)) as Row) : null;
      this.log.push({ version, at: this.now(), siteId, entity: w.entity, id: w.id, op, data });
      this.entities.set(key, { entity: w.entity, id: w.id, siteId, data, deleted: op === 'del' });
    }
  }

  /** Whether a defect hides this row from every read path. */
  private dropped(entity: EntityName, id: string): boolean {
    return this.defects.has('drop-first-row') && entity === this.first?.entity && id === this.first?.id;
  }

  private shown(entity: EntityName, data: Row | null): Row | null {
    return this.defects.has('corrupt-status') && entity === 'ticket' && data
      ? { ...data, status: 'constructor' }
      : data;
  }

  /** Live rows of the user's sites in key order (site, entity, id), from the page key on; never compacted. */
  private snapshot(user: SimUser, params: URLSearchParams): SimResponse {
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 500), 1), 500);
    const watermark = params.has('watermark') ? Number(params.get('watermark')) : this.head;
    if (watermark < this.floor) return this.gone();
    const after = params.has('afterSite')
      ? `${params.get('afterSite')}/${params.get('afterEntity')}/${params.get('afterId')}`
      : undefined;
    const sites = this.sites(user);
    const rows = [...this.entities.values()]
      .filter((e) => !e.deleted && e.data && sites.has(e.siteId) && !this.dropped(e.entity, e.id))
      .map((e) => ({ key: `${e.siteId}/${e.entity}/${e.id}`, e }))
      .filter((r) => after === undefined || r.key > after)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.e;
    return json(200, {
      watermark,
      head: this.head,
      rows: page.map(({ e }) => ({ entity: e.entity, id: e.id, siteId: e.siteId, data: this.shown(e.entity, e.data) })),
      next: rows.length > limit && last ? { siteId: last.siteId, entity: last.entity, id: last.id } : null,
    });
  }

  private pull(user: SimUser, params: URLSearchParams): SimResponse {
    const cursor = Number(params.get('cursor') ?? 0);
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 500), 1), 500);
    const clientId = params.get('clientId');
    if (cursor < this.floor) return this.gone();
    const sites = this.sites(user);
    const ignoreSites = this.defects.has('foreign-rows') && cursor > 0;
    const page = this.log
      .filter((e) => e.version > cursor)
      .filter((e) => !this.dropped(e.entity, e.id))
      .filter((e) => ignoreSites || sites.has(e.siteId))
      .slice(0, limit);
    const head = this.head;
    return json(200, {
      changes: page.map((e) => ({
        version: e.version,
        entity: e.entity,
        id: e.id,
        siteId: e.siteId,
        op: e.op,
        data: this.shown(e.entity, e.data),
      })),
      nextCursor: page.length === limit ? (page.at(-1)?.version ?? cursor) : Math.max(cursor, head),
      hasMore: page.length === limit,
      lastMutationId: clientId ? (this.lastMutation.get(clientId) ?? 0) : 0,
      head,
    });
  }
}
