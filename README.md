# FieldSync

An offline-first field-service platform: technicians open and update service tickets (and the
parts used) without connectivity; changes sync to an authoritative Postgres-backed server.

- [Overview](#overview)
- [Running](#running)
- [Configuration](#configuration)
- [Architecture & data flow](#architecture--data-flow)
- [Guarantees](#guarantees)
- [Decision records](#decision-records)
- [Found issues](#found-issues)
- [Changes to starter tests](#changes-to-starter-tests)
- [Simulation](#simulation)
- [Load test](#load-test)
- [Indexes](#indexes)
- [Observability](#observability)
- [Limitations & what we'd do differently](#limitations--what-wed-do-differently)

## Overview

| Path | What |
|---|---|
| `packages/sync-core` | Protocol types, shared mutators, sync client (runs in Node and the browser) |
| `apps/server` | NestJS API: push, pull, SSE stream, change-log GC; TypeORM for the pool, transactions and migrations, SQL queries |
| `apps/web` | Next.js (App Router) UI |
| `packages/test-kit` | Test helpers shared by the test suites: `knownDefect` and its Jest reporter |
| `e2e` | Playwright end-to-end tests against the production builds |
| `scripts` | `docker-smoke.sh` (image and stack checks), `audit-starter-tests.sh` (evidence for the starter test audit) |

Protocol in brief:

1. The client queues named mutations with a per-client monotonic id and applies them optimistically.
2. `POST /sync/push` sends the queue; the server applies each mutation in a transaction.
3. `GET /sync/pull?cursor=N&clientId=…` returns changes with `version > N` for accessible sites;
   a cursor below the collected part of the log is answered 410 `RESET_REQUIRED`.
4. `GET /sync/snapshot` returns the live state page by page; a new client, and one that was reset,
   starts from it and then pulls the log from its watermark.
5. `GET /sync/stream` emits `poke` events so clients pull promptly, and heartbeats.
6. Every request names the protocol version it speaks (`FieldSync-Protocol`); the server tells an
   outdated client to update.
7. In the browser the client keeps its whole state (queue included) in IndexedDB, one database per
   user; one tab of the user talks to the server, the others follow it.

## Running

Requirements: Node 20.12 or newer within 20.x (`.nvmrc`), npm 10, Docker.

### With Docker

```bash
docker compose up --build
```

This starts Postgres, runs the migrations once (`migrate` service), then the API on
<http://localhost:3001> and the web app on <http://localhost:3000>; each service waits for the
previous one to be healthy (or, for `migrate`, finished). Settings and host ports come from the
environment or a `.env` file in the repository root (see `.env.example`). Postgres data lives in
the `postgres-data` volume; `docker compose down -v` removes it.

Demo tokens (with `SEED_DEMO=true`, the compose default): `admin-token` (all sites),
`tech-a-token` (North Plant), `tech-b-token` (South Plant).

### Locally

```bash
npm ci
docker compose up -d postgres
cp apps/server/.env.example apps/server/.env
npm run build
npm run migrate
npm start -w @fieldsync/server
npm run dev -w @fieldsync/web
```

The server refuses to start while migrations are pending; run `npm run migrate` after pulling
changes that add migrations.

With `API_DOCS_ENABLED=true` the server describes its API at <http://localhost:3001/docs>
(Swagger UI) and `/docs-json` (OpenAPI). Every route except `/health` needs
`Authorization: Bearer <token>`.

### Checks and tests

| Command | What it runs | Needs |
|---|---|---|
| `npm run lint` | ESLint with type information for all packages, the server, e2e and (via `next lint`) the web app; warnings fail | |
| `npm run format:check` | Prettier check (`npm run format` applies it); Markdown is formatted by hand | |
| `npm run typecheck` | `tsc --noEmit` for sync-core, test-kit, sim, server, web and e2e | |
| `npm run test:unit` | Unit tests of test-kit, sync-core, the simulation engine and the server (every service method, with its collaborators replaced in the Nest testing module) | |
| `npm run test:integration` | Server tests on a real Postgres | `DATABASE_URL` |
| `npm run test:sim` | The simulation corpus against the real server on Postgres (see [Simulation](#simulation)) | `DATABASE_URL` |
| `npm run test:bench` | Push throughput through the change log's head (16 clients, 2000 mutations; `BENCH_CLIENTS`, `BENCH_MUTATIONS`): checks each mutation is applied once and prints mutations/s and latency percentiles; not part of `npm test` | `DATABASE_URL` |
| `npm run sim -- --help` | Local simulation search over any number of scenarios, with shrinking (see [Simulation](#simulation)) | `DATABASE_URL` |
| `npm test` | Unit, integration and simulation tests; database suites are skipped (with a notice) without `DATABASE_URL` | |
| `npm run test:e2e` | Playwright, Chromium, against the production builds | `npm run build`, `DATABASE_URL`, `npx playwright install chromium` once |
| `scripts/docker-smoke.sh` | Builds the images, checks them (non-root, no `.env` files, resource limits) and starts the compose stack | Docker |
| `scripts/scan-images.sh IMAGE...` | Known vulnerabilities of the images (Trivy, report only; CI puts it in the job summary) | Docker |
| `scripts/audit-starter-tests.sh` | Shows the rewritten starter tests were vacuous (see [Changes to starter tests](#changes-to-starter-tests)) | `DATABASE_URL`, built packages |

`DATABASE_URL` names a maintenance database, e.g.
`postgres://fieldsync:fieldsync@localhost:5432/fieldsync` with `docker compose up -d postgres`.

- **Integration tests** never touch that database's data. Global setup creates a template
  database and migrates it once per run; every test file then gets its own clone
  (`CREATE DATABASE … TEMPLATE`, about 30 ms) and drops it afterwards, so files cannot see each
  other's data and each one behaves the same alone or in any worker. Fixtures write straight to
  the database, independently of the server code under test. The server under test is the real
  application module, built with `Test.createTestingModule` and `app.init()` and called through
  supertest, as the NestJS testing documentation describes; its settings go through the
  production validation but come from the test, not from the process environment. With `REQUIRE_DB=1` (set in CI) a missing `DATABASE_URL` fails
  the run instead of skipping the suites.
- **E2e tests** recreate and migrate a dedicated database (`E2E_DATABASE`, default
  `fieldsync_e2e`; the name must end with `_e2e`, so no other database can be dropped by mistake)
  on every run, start the built server and web app, and give every test its own
  sites and users. The web bundle has the API URL compiled in, so build with the default
  `NEXT_PUBLIC_API_URL` (`http://localhost:3001`); ports 3000 and 3001 must be free.
- **Known-defect tests.** A defect that is reproduced but fixed by a later change is tracked with
  `knownDefect({ id, owner, reason }, name, body)` (the owner is the area whose change fixes it, e.g. `access-control`) from `@fieldsync/test-kit`. The body asserts the
  correct behaviour. The test passes only while the body fails with an assertion error; any other
  error fails it (a broken harness must not look like a reproduced defect), and a body that passes
  fails it with "defect F-NN appears fixed - flip it". Only the assertion that shows the defect uses
  `expect`; every setup check in the body uses `precondition()`, whose failure is never taken for
  the defect. Every run prints the open known defects, and CI lists them in the job summary.

## Configuration

The server reads its settings once at startup (`@nestjs/config`) and validates all of them before
any other module is built; any invalid value stops it with a list of every problem, for example:

```
Invalid configuration:
  - PORT must be an integer from 1 to 65535 (got "x")
  - GC_INTERVAL_MS must be an integer from 1000 to 2147483647 (got "1h")
```

The three database timeouts are sent as session settings when each connection of the server's pool
opens (node-postgres connection parameters), not set for the whole database: PostgreSQL advises
against `lock_timeout` and `statement_timeout` in `postgresql.conf`, and `npm run migrate` uses its
own connections without them.

Values come from the environment, then from `.env` in the working directory (`apps/server/.env`
for `npm start -w @fieldsync/server`) when present; the environment wins. Blank values count as
unset. `npm run migrate` reads the same variables with the same rules. Only the variables in the
table are taken from `.env`; anything else there (for example libpq's `PG*` defaults) does not
reach the process, so connection settings belong in `DATABASE_URL`. `DATABASE_URL` is a secret: it is never logged or echoed in
errors.

| Server variable | Default | Valid values | Meaning |
|---|---|---|---|
| `PORT` | `3001` | 1–65535 | HTTP port of the API |
| `DATABASE_URL` | required | A `postgres://` or `postgresql://` connection string (libpq rules, e.g. `?host=/var/run/postgresql` for a Unix socket) | Database connection; every connection setting, TLS included (`sslmode`, ...), belongs in it |
| `DB_POOL_MAX` | `20` | 1–1000 | Maximum connections in the server's pool |
| `DB_LOCK_TIMEOUT_MS` | `2000` | 1–600000 | Longest wait for one lock on a server connection (`lock_timeout`). A writer that waits longer, for example behind a transaction that hangs while holding the change log's head, gets a 503 with `Retry-After` and retries |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | 1–3600000 | Longest run of one statement on a server connection (`statement_timeout`); a page of the log or a mutation takes milliseconds |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `10000` | 1–3600000 | Postgres ends a server session that idles inside a transaction this long (`idle_in_transaction_session_timeout`), rolling it back and freeing its locks |
| `SEED_DEMO` | `false` | `true`, `false` | Insert demo sites, users and well-known tokens on startup (development only) |
| `CHANGELOG_RETENTION_SECONDS` | `604800` | 3600–2147483647 | Change-log entries older than this are removed by the GC, oldest first. A client whose cursor falls behind them is reset (410) and reloads from a snapshot. At least an hour: a snapshot must finish within the retention (see [3.3.6](#change-log-lifecycle-336)) |
| `MUTATION_RESULT_RETENTION_SECONDS` | twice `CHANGELOG_RETENTION_SECONDS`, at least `1209600` | 3600–2147483647, ≥ `CHANGELOG_RETENTION_SECONDS` | Results of rejected mutations (and of applied ones that changed nothing) are kept this long, so a retried copy is answered with the same rejection; results of applied mutations go with the log entries of their changes |
| `GC_BATCH_SIZE` | `5000` | 100–100000 | Most change-log entries one GC transaction removes |
| `STREAM_HEARTBEAT_MS` | `15000` | 1000–60000 | Heartbeat interval of an idle notification stream. Clients treat a stream silent for three intervals as dead and reconnect; the HTML standard suggests a keep-alive "every 15 seconds or so" against proxies that drop idle connections |
| `GC_INTERVAL_MS` | `3600000` | 1000–2147483647 | How often the GC runs. At least a second, so a millisecond/second mix-up cannot turn the GC into a load test; at most what `setInterval` accepts |
| `JSON_BODY_LIMIT_BYTES` | `2097152` | 1048576–67108864 | Largest JSON request body. Never below the 1 MiB the client puts in one push (`MAX_PUSH_BODY_BYTES`), so its batches are not refused for their size |
| `API_DOCS_ENABLED` | `false` | `true`, `false` | Serve the OpenAPI description at `/docs-json` and Swagger UI at `/docs`, without a token. Off by default so the API surface is not published by accident |

In Docker compose every service has a memory and CPU limit (Postgres 2 CPUs and 1 GiB, the Node
services 1 CPU and 512 MiB), and the Node services set `--max-old-space-size=384` so V8 collects
garbage before the container reaches its limit. Change them in `docker-compose.yml` for larger
data sets.

Docker compose reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `BIND_ADDRESS`,
`POSTGRES_PORT`, `SERVER_PORT`, `WEB_PORT`, `SEED_DEMO` and `NEXT_PUBLIC_API_URL` (all with
defaults; see `.env.example`). Ports are published on `127.0.0.1` unless `BIND_ADDRESS` says
otherwise, since the defaults include a well-known database password and demo tokens; the web
bundle calls the API on `SERVER_PORT` unless `NEXT_PUBLIC_API_URL` is set. The web app has one setting, `NEXT_PUBLIC_API_URL`, compiled into the bundle at
build time (`apps/web/.env.example`).

Test settings (`DATABASE_URL`, `REQUIRE_DB`, `E2E_DATABASE`, `E2E_WEB_PORT`) are described in the
root `.env.example`.

## Architecture & data flow

Not written yet: the diagram and its description are added once the delivery path (change-log
ordering, notifications, snapshots) is final.

## Guarantees

Not written yet: the guarantee model is stated once ordering, idempotency and log compaction are
in place.

## Decision records

### Data access: TypeORM

**Context.** The original server used `pg` directly: a pool, raw SQL, a hand-written
`BEGIN`/`COMMIT`/`ROLLBACK` helper and the whole schema run with `CREATE … IF NOT EXISTS` on every
startup. There was no record of the schema version and no way to evolve it, and the transaction
helper had defects (F-14, F-15). The task allows an ORM if the choice is justified.

**Options.**

1. Keep `pg`, add a migration runner of our own.
2. TypeORM as the connection, transaction and migration layer; queries stay SQL.
3. TypeORM with entities and repositories.

**Decision: option 2.** TypeORM provides versioned migrations with a migrations table, one
transaction per migration with a per-migration opt-out (needed for `CREATE INDEX CONCURRENTLY`),
`QueryRunner` transactions and savepoints, and a pool that handles dropped connections. No
entities: the sync protocol depends on exact SQL (row locks, `ON CONFLICT`, `RETURNING`, and later
savepoints, keyset snapshots and advisory locks), the index tests check the plans of exactly these
statements, and entities would describe the schema a second time next to the migrations, for a
handful of trivial reads.

**What we built on top, and why.**

- `Sql` interface with one result shape, `{ rows, rowCount }`. TypeORM's raw `query()` returns
  rows for `SELECT`/`INSERT` but `[rows, count]` for `UPDATE`/`DELETE`; the structured result
  avoids that trap, and the services changed only from `db.pool.query` to `db.query`.
- `Db.tx`: commits or rolls back, logs a failed rollback instead of throwing it so the original
  error reaches the caller (TypeORM's `rollbackTransaction` throws), and always releases.
- `npm run migrate` holds a Postgres advisory lock: TypeORM takes no lock, so two processes would
  both apply the same pending migrations. The lock has a connection of its own, outside the pool,
  with idle-session and statement timeouts switched off (it is idle while the migrations run) and
  TCP keepalive on. It is a session-level lock, so `migrate` must reach Postgres directly or through
  a pooler in session mode; behind transaction pooling (e.g. PgBouncer's transaction mode) it would
  protect nothing. A run waits at most
  10 minutes for another one and then fails with a message naming the lock, so a stuck run cannot
  hang later deploys silently. If the lock connection is lost anyway, the run still reports what it
  applied and warns that another run may have run at the same time.
- `migrationsTransactionMode: 'each'`: in the default `all` mode TypeORM refuses any migration
  that sets `transaction = false`.
- A TypeORM logger that never writes query parameters (they carry tokens and user data).
- The initial migration is the original schema, idempotent, so it adopts a database created by the
  original server without changing its schema or data (tested on a populated database).

**Wiring.** The server gets its `DataSource` from `@nestjs/typeorm` (`TypeOrmModule.forRootAsync`
with options from the validated configuration), which initializes it on startup and closes it on
shutdown; `Db` wraps the injected `DataSource`. The module retries a failed connection 9 times,
3 s apart, on any error by default (a wrong password included); `toRetry: () => false` turns that
off, so a server that cannot reach its database fails at once with the driver's error and the
process manager restarts it (tested: a wrong password fails in well under 2 s). The migration
command is a Nest standalone application with the same configuration and data source modules.
One options factory (`dataSourceOptions`) serves the server, the migration command and the tests
that need a `DataSource` outside Nest.

**Safety of the switch.** The characterization tests of the HTTP API and the access tests were
written against the `pg` implementation and pass unchanged after the switch
(`git diff a9c598a 291d9bb -- apps/server/test/integration/sync.characterization.spec.ts` is
empty).

**Remaining limitations.** TypeORM's `QueryFailedError` carries the failed query's parameters:
anything that serializes whole error objects (structured logging) must drop them. TypeORM is
pinned to an exact version because `Db.tx` relies on how it releases broken connections, which is
covered by tests.

### Request pipeline

Authentication is a global guard (`APP_GUARD`): every route requires a bearer token unless it is
marked `@Public()` (only `/health`), so a new route cannot be left open by omission. A global
`ValidationPipe` (`APP_PIPE`, `whitelist`, `transform`) validates DTO-typed parameters (`stopAtFirstError`: one
message per invalid field); the push body and the pull query are DTOs, the arguments of a mutation
are checked by the shared mutators in `sync-core`. A global filter (`APP_FILTER`) answers every
error as a problem document (RFC 9457). Both are
registered in the module, as the NestJS documentation recommends, so in-process test applications
get them too. Which sites a user may read or write is decided per row from the database, inside the
services, not by a route guard.

### Server configuration

`@nestjs/config` (`ConfigModule.forRoot`, global, cached) with a `validate` function built on
`class-validator` and `class-transformer`, as in the module's documentation. Services read typed
values through `ConfigService<EnvironmentVariables, true>` with `infer: true`.

The validation keeps the rules of the original loader, which the documentation's example would
loosen: integers are converted only from decimal strings (`enableImplicitConversion` would accept
`1e4` and `0x10` and turn an empty string into 0), blank values count as unset, every problem is
reported at once with the variable's name, and the database URL never appears in a message.
`ConfigModule.forRoot` validates while it builds the module, so an invalid setting stops the server
before Nest starts any other module, and `main` prints only the report. Applications built
in-process (tests, the simulation) pass their settings explicitly and ignore the process
environment and `.env`, so several of them can run in one process with different settings.

### Deterministic simulation (3.3.2)

**Context.** Convergence under failures has to be shown, not argued: many clients, a network that
loses, duplicates, reorders and delays requests and breaks connections in the middle of a request,
and a property checked after the network recovers. Any failure must be reproducible from a seed and
small enough to read.

**Options.**

1. A model of the server in memory, driven by a property-testing library: fast, but it proves the
   model, not the server that ships.
2. The real `SyncClient`, the real server and Postgres, with real concurrency and real timers:
   realistic, but a failure depends on thread and network timing and cannot be replayed from a
   seed.
3. The real `SyncClient` with the production `HttpTransport`, the real NestJS application on a
   real Postgres in the same process, with the network, time and the order of events under the
   control of the test: each run is a sequence of steps generated from a seed.

**Decision: option 3**, built on the documented tools of
[fast-check](https://fast-check.dev/docs/advanced/model-based-testing/) rather than an engine of
our own. Everything except the network and the clock is the code that ships, and every source of
nondeterminism is controlled:

- **Scenarios:** fast-check model-based testing. The fault phase of a run is a list of commands
  (`fc.commands`), one per step (a user action, a delivery with a fault, a timer tick, a link
  change; see [Simulation](#simulation)), run in order by `fc.asyncModelRun`. Randomness is
  fast-check's own generator, driven by the seed; ids and fixtures are derived from positions, so
  they are never random.
- **Shrinking:** fast-check shrinks a failing scenario (fewer commands, smaller choices) and keeps
  only reductions that still fail. The search runs `fc.check` with `endOnFailure`, so every
  generated scenario is reported once; shrinking then resumes from the failure's seed and path
  with a time limit (`skipAllAfterTimeLimit`), and the smallest failing scenario found so far is
  reported. A failure replays exactly from its seed, its path and fast-check's `replayPath`.
- **Time:** a virtual clock shared by the clients (`SyncClock`, injected into `SyncClient`) and the
  server (the `Clock` provider, replaced through `@nestjs/testing`): a standalone
  [`@sinonjs/fake-timers`](https://github.com/sinonjs/fake-timers) clock (`createClock`), which
  replaces no global, because the server, the database driver and Jest in the same process need
  real timers. Each client's clock may be skewed.
- **Order:** one step at a time; after each step the run waits until the clients have no work left
  that does not wait on the network or a timer. Requests reach the server one at a time.
- **Network:** a `fetch` implementation given to the production `HttpTransport`, so request
  serialisation, status handling and the JSON round trip are the production code paths. It hands
  requests to the server through [supertest](https://github.com/ladjs/supertest) on the
  initialised application (`app.init()`, as in the NestJS end-to-end testing guide), without
  opening a port.
- **Data:** every run starts from `TRUNCATE … RESTART IDENTITY`, so change-log versions start at 1
  and rows are stored in the same physical order (a `DELETE` would leave dead rows that autovacuum
  reclaims at unpredictable times). Rows are compared as JSON with sorted keys
  ([`safe-stable-stringify`](https://github.com/BridgeAR/safe-stable-stringify)).

**Why not `fc.scheduler`.** fast-check's scheduler orders promises that the test schedules; here the
order of events is the network's (which request is delivered, with which fault, which answer goes
back) and the clients' timers, and both are explicit commands. Expressing them as commands lets
fast-check shrink them like any other step.

**Remaining limitations.** See the end of [Simulation](#simulation).

### Pending decision records

Partial replication (3.3.4) and SSE authentication are recorded with the changes that implement
them.

### Protocol correctness (3.3.1)

**Context.** The original server gave a change its version from a `bigserial` when the row was
inserted, not when the transaction committed. A transaction that started first and committed last
published a version below the cursor of a reader that had already passed it, and the change was
never delivered (F-25). It read the client's last mutation id outside the mutation's transaction
and without a lock, so parallel copies of one mutation were all applied (F-26). A rejected mutation
failed the whole push with 500, and the client retried it forever (F-23). The task asks for
delivery of every change in an order that does not depend on the order of commits, idempotent
application under any number of retries and parallel requests, and a rejection that does not block
the queue and tells the client why.

**Options for the order of changes.**

1. Keep the sequence and let readers stop below the oldest transaction still in progress
   (`pg_snapshot_xmin`, or a column with the writer's transaction id): writers stay parallel, but
   every pull has to work out a safe horizon, a long transaction holds back delivery for everyone,
   and the versions still have gaps.
2. A one-row counter (`log_head`) that every writing transaction increments as its last
   statement, holding the row lock until it commits: versions are assigned in commit order and
   without gaps, readers need nothing special.
3. An advisory lock around every writing transaction: the same order, but writers serialize for
   their whole duration, not only for the last statement.
4. A separate sequencer (logical decoding or an outbox read by one process) that numbers committed
   changes: correct and parallel, but another moving part and a delay between commit and delivery.

**Decision: option 2.** A transaction locks the client's row, then the entity rows it reads and
writes (by key, a ticket before its parts), and increments `log_head` in the same statement that
appends to the change log, stamps the entities and records the result, so the head is held only
from that statement to the commit. A deadlock is not possible with one lock order, and the stress
test with 16 clients on three tickets sees none. Cost, measured by `npm run test:bench`
(16 clients, 2000 one-mutation pushes, local Postgres 16): about 660 mutations/s against about
890/s for the original server (76 %), p95 latency about 49 ms against about 25 ms; 99 % of the
head's updates are HOT. The accepted threshold for this benchmark is at least 70 % of the
original throughput and a p95 of at most 50 ms on the same machine; CI runs it for correctness only,
since timings on shared runners vary too much to assert. The load test of the observability work
measures it with 200 clients.

**Idempotency.** Each mutation is its own transaction. It locks the client's row (`SELECT … FOR
UPDATE`, after an `INSERT … ON CONFLICT DO NOTHING` for a new client), so parallel copies of one
mutation queue up and the second sees the first one's result. `mutation_results` keeps the outcome
of every mutation: a copy of an applied one is answered `duplicate` with the version of its change,
a copy of a rejected one with the same rejection; only the client's owner gets these outcomes
(F-33). The results of applied mutations are deleted with the log entries of
their changes; rejections are kept longer (see [3.3.6](#change-log-lifecycle-336)). Client ids are
UUIDs. Push stays `READ COMMITTED`: under `REPEATABLE READ` two copies of a new client's first
mutation fail with 40001 on the `ON CONFLICT` insert.

**Rejections.** The mutator runs inside a savepoint. A `MutationRejected` rolls back to it, and the
rejection (`code`, `message`, `details`) is recorded like an application: the client's last
mutation id moves on and the mutations behind it are applied. Any other error of the mutator would
fail the same way on every retry, so it is rejected as `INTERNAL` and logged with its stack. Errors
of the moment (SQLSTATE classes 08, 40, 53, 57, and 55P03, 25P03) apply nothing and answer 503 with
`Retry-After`. A gap in the mutation ids answers 409 `MUTATION_OUT_OF_ORDER` with the id expected.
Every error answer is a problem document (RFC 9457) with a stable `code`, which the client keeps as
`syncError`. Timeouts for locks, statements and idle transactions (`DB_LOCK_TIMEOUT_MS`,
`DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`) keep a stuck transaction that holds
the head from stopping every writer: they get 503 and recover when Postgres ends it.

**Pull.** One `REPEATABLE READ READ ONLY` transaction reads the head, then at most `limit` changes
with versions up to the head, and the client's last mutation id, all from one snapshot. Pages are cut
by version, independently of the site filter; without more changes the cursor moves to the head.
The client drops pending mutations that the server has applied only once it has caught up
(`hasMore` false), and keeps an applied mutation in its view until it has pulled the change it made
(the version in the push answer), so nothing flickers away in between (F-30).

**Evidence.** `commit-order.spec.ts` (two real connections commit out of order; a stress test with
writers and readers checks that no reader skips a change), `duplicates.spec.ts` (parallel and
retried copies), `pull-snapshot.spec.ts`, `stuck-transactions.spec.ts`, `process-crash.spec.ts`
(the server process is killed with SIGKILL in the middle of a mutation: no trace is left, and the
mutation applies when sent again), `lock-order.spec.ts`, and the simulation.

**Remaining limitations.** Writes are serialized on the head for the last statement of each
mutation, which bounds write throughput per database. A 409 means the client lost the mutations
the server misses (a lost local queue); the client then retires its id and continues under a new one
(see [3.3.3](#offline-first-client-333)). After
`MUTATION_RESULT_RETENTION_SECONDS` a copy of a rejected mutation is answered `duplicate` without its
reason.

### Merge semantics (3.3.5)

**Context.** `ticket.update` always wrote both the title and the description, so of two offline
edits of different fields the second sync undid the first (F-27). `ticket.delete` left the
ticket's parts behind (F-31). Quantity adjustments and status changes were already relative to the
stored row (a delta, a `from` status), but a conflict was reported as a bare code. The task asks
that edits of different fields do not overwrite each other, that quantity changes commute, and that
a conflicting status change is rejected with an explanation the user can act on.

**Options for edits.**

1. Last writer wins for the whole row (the original behaviour): loses edits.
2. Last writer wins per field: different fields merge, but of two edits of one field one is lost
   without anybody being told.
3. A version per ticket (optimistic locking): nothing is lost, but edits of different fields
   conflict as well.
4. Per-field patch with the value the user saw (`base`): different fields merge; an edit of a field
   someone else changed since is rejected with both values.
5. Merging text (operational transform, CRDT): out of scope (task, section 9).

**Decision: option 4.** An edit carries only the fields the user changed and, for each, the value
on the user's screen (`ticketEdit()` in `sync-core`, used by the ticket page and the simulation).
The server applies it if the stored value is still that one, or already the one typed; otherwise it
rejects with `FIELD_CONFLICT` and, per field, `current` and `yours`. An edit without `base` (queued
by the original client) writes its fields, last write in server order winning. Quantity changes
are deltas, so concurrent adjustments both count in any order, and only one that would take the
quantity below zero is rejected (`NEGATIVE_QUANTITY` with the stored quantity and the delta). A
status change names the status it starts from: `STATUS_CONFLICT` carries the current status and the
transitions it allows, `INVALID_TRANSITION` the allowed ones. Deleting a ticket deletes its parts in
the same transaction (locked ticket first, then the parts by id), so a concurrent part edit is
rejected as `NOT_FOUND`.

**Evidence.** `mutators.spec.ts` (the whole transition table, patches, conflicts, the cascade),
`determinism.spec.ts` (adjustments commute), `merge.spec.ts` and `delete-ticket.spec.ts` on
Postgres, and the simulation's "no lost edits" property.

**Remaining limitations.** The UI shows a rejection's code and message in the existing list;
acting on it (keeping one of the two values, retrying a status change) is part of the frontend work
(3.3.9). Two edits of one field always conflict, even when they could be merged as text.

### Change-log lifecycle (3.3.6)

**Context.** The original GC deleted change-log entries older than the retention and told nobody
(F-34): a client whose cursor was older pulled an empty page and silently missed those changes for
good, a new client pulled from 0 and never got the entities whose history was gone, and since a
change's `created_at` is its mutation's clock reading taken before the commit, deleting by age could
remove a newer version and keep an older one. Tombstones (deleted entities) were never removed. The
task asks for compaction with a safe "full reload required" signal for clients whose cursor is too
old, a snapshot instead of the history for new clients, and a modelled and tested client that was
offline longer than the retention.

**Options.**

1. Delete by age without a signal (the original behaviour): loses changes.
2. Compact to the latest change per entity (keep one row per entity in the log): the log never
   shrinks below the number of entities, deletions must be kept forever, and every reader still
   pages through all of it from 0.
3. Retention plus a floor plus a snapshot: remove a prefix of the log older than the retention,
   record the highest removed version (`log_floor`), answer cursors below it with a reset signal,
   and serve the live state as a snapshot.
4. Table partitioning of the log by range, dropping whole partitions: what PostgreSQL recommends
   for bulk deletes of old data ("far faster than a bulk operation" and no VACUUM afterwards), but
   "worthwhile only when a table would otherwise be very large", with the rule of thumb that it
   exceeds the server's memory (PostgreSQL 16, 5.11). It also needs partitions created ahead of the
   writers and makes the retention coarse.

**Decision: option 3, with batched deletes.** The GC removes the log in prefixes by version: a
batch is the next `GC_BATCH_SIZE` versions after the floor, cut before the first change younger than
the cutoff, so a later version with an earlier timestamp is never removed while an older one is
kept. One statement deletes the batch, the tombstones and the results of applied mutations whose
versions it covers, and raises `log_floor`, in a transaction that first locks the `log_floor` row
with `SKIP LOCKED`: a second GC (another instance, or a run that took longer than the interval)
finds it taken and stops instead of waiting or removing the same rows. `log_floor` is a row of its
own, not a column of `log_head`, so the GC never holds the row every writer updates. On shutdown the
GC stops between batches and the application waits for the batch in progress before the database
pool closes (NestJS lifecycle events).

A pull with a cursor below the floor is answered **410 Gone** with the problem code
`RESET_REQUIRED` and `details.floor`: the history after the cursor is gone for good, which is what
RFC 9110 (15.5.11) defines 410 for; Google Calendar answers an invalidated sync token with 410
("a full wipe of the client's store and a new full sync"), and Microsoft Graph signals a required
full resynchronization the same way. 409 would also fit ("the user might be able to resolve the conflict and resubmit"), but
says less. A 410 is heuristically cacheable (RFC 9110, 15.1), so it is sent with
`Cache-Control: no-store`, as are the pull and snapshot answers.

`GET /sync/snapshot` returns live rows of the user's sites in key order `(site_id, entity, id)`,
at most 500 per page (keyset pagination through the index `entities_snapshot_idx`). The first page
fixes the **watermark**, the head of the log read in the same `REPEATABLE READ` transaction; every
next page passes it with the key of the previous page's last row, and after the last page the
client pulls the log from the watermark.

*Why snapshot plus tail converges, whatever is written meanwhile.* Pages are separate requests, so
each shows its rows as they are when it is read, not as of the watermark W. A row that does not
change after W reads the same in every page. Every change after W is in the log after W, in commit
order and without gaps (decision record 3.3.1), so pulling from W ends every changed row at its
last change: a row edited before or after its page, created behind the page cursor, deleted before
its page, or (with partial replication) moved to another site is put right by the log. Rows of a
page may already hold changes after W, which the log then replays; the client applies the snapshot
and the log to a separate map and only then makes it its state, so a value replayed from the log
over a newer one from a page never shows. The log after W must still exist when the client pulls
it, that is W must not fall below the floor, which brings the next choice.

*No lease on the watermark.* The floor only passes changes older than the retention, and every
change after W committed after the snapshot started, so the floor reaches W only once the snapshot
is older than the retention, less the longest transaction (bounded by `DB_STATEMENT_TIMEOUT_MS`) and
the clock difference of the server instances. A snapshot that slow is answered 410 and starts over;
one that finishes within the retention never is, so a slow client cannot be reset again and again.
The retention is therefore at least an hour. A lease table (as the NestJS locks documentation
describes for leases) would give the same guarantee with a write on every page of a `GET` and a way
for a client to hold the log back forever by renewing it; it is needed only for compaction by size,
which the task does not ask for.

*The client* (`SyncClient`) without a stored state, or answered `RESET_REQUIRED`, shows the status
`loading` and reads the snapshot and the tail. Its queue is kept: mutations whose effect the new
state has (applied up to the cursor, or handled according to the last page's `lastMutationId`, which
comes from the same database snapshot as the page) leave the queue, the others are replayed on top
of the new state, and rejections stay listed. An interrupted snapshot leaves the previous state in
place and starts over at the next sync; after three resets in one sync the client waits for its
next retry.

*Tombstones and results.* Tombstones (key, site and version, no data) are kept for good, so a deleted
id is never taken again. The log lifecycle change first removed a tombstone with the log entry of its
deletion; then an offline client's queued `ticket.delete` of the old ticket would have deleted a new
ticket created under the same id, so the offline-client change keeps them. Results of applied mutations go
with their log entries too (their `version` would point into the collected log). Rejections, and
mutations that changed nothing, have no version; they are kept for `MUTATION_RESULT_RETENTION_SECONDS`
(by default twice the log retention and at least 14 days, never less than the log retention), so a client reset after a week offline
still learns why its queued mutations were rejected.

**Consequences.** The log, the tombstones and the results are bounded by the retention. New clients
read the live state, not the history. A client away longer than the retention reloads and keeps
its queue. Costs: a reset client downloads its whole state again; the snapshot must finish within
the retention; a tombstone stays for every deletion.

**NFRs, measured** (`npm run test:bench`, 16 clients, local Postgres 16, see [Indexes](#indexes) for
the queries): one GC batch of 5000 versions takes about 10 ms; collecting a backlog of 200 000
entries took about 0.4 s while the clients pushed. Push p95 rose from about 49 ms to 51–55 ms and
p99 from about 70 ms to 80–100 ms during that collection; batches of 1000 or 2000 did not change it,
since the GC and the writers share one database. In steady state the GC runs hourly and removes an
hour of changes.

**Evidence.** `log-compaction.spec.ts` (F-34), `snapshot.spec.ts` (pages, access, validation, 410,
convergence with rows changed between pages and with four writers and four readers at once),
`gc-concurrency.spec.ts` (a second instance collecting as fast as it can while writers push and
readers pull or reset, two collectors at once, the collector's session killed in the middle of a
batch, shutdown in the middle of a run, a slow snapshot), `process-crash.spec.ts` (the server process
killed with SIGKILL, or frozen with SIGSTOP until Postgres ends its idle transaction, in the middle
of a batch), `log-retention.spec.ts` (tombstones and results), unit tests of `GcService`,
`SnapshotService`, `PullService` and of the client's reset and rebase (`snapshot.spec.ts` in
`sync-core`), and the simulation's `compact` and `away` steps.

**Remaining limitations.** Partitioning (option 4) is the documented way once the log outgrows the
database server's memory. A client released before this change does not know `RESET_REQUIRED`: it
keeps retrying the pull until it is updated (versioning of the protocol, 3.3.7). During a rolling
update the old server's GC still deletes by age without raising the floor: stop the old instances
(or their GC) before the new ones migrate the database. Reverting the migration removes the floor,
so a revert needs every client to reload.

### Offline-first client (3.3.3)

**Context.** The original client kept the server's rows and its cursor in `localStorage` and its
queue in memory (F-10), allocated mutation ids in memory, so two tabs used the same ones (F-11),
ignored a refused write (F-38), had no request timeout (F-13), retried every 5 s, and its web app
never closed it (F-37). The task asks for a queue that survives reloads, tabs that do not break each
other's queue, reconnection with exponential backoff and jitter, and a status that tells synced,
pending, offline and rejected apart.

**Storage.** IndexedDB through `idb` (decision Д-6), one database per user (named after a SHA-256
of the token, F-40), four stores: `meta` (client id, cursor, last and next mutation ids, an update
refusal, a client id being retired), `base` (the server's rows), `pending` (the queue, keyed by a
generated position) and `rejections`. Every change of the state is one transaction that awaits only
its own requests (a transaction commits once it has no pending request: MDN, `idb` "Transaction
lifetime") and aborts on any failure; queue writes use `durability: 'strict'`, pull pages and
snapshots, which the server can send again, `relaxed`. A mutation gets its id in the transaction that
queues it and is shown only once stored: what the user sees survives a reload. `MemoryStorage`
implements the same interface for tests and the simulation.

| Point a page can close at | What the client does after the reload |
|---|---|
| before a mutation's transaction commits | the mutation is not queued and was never shown |
| after it, before the push | the queue sends it |
| push sent, no answer (or answer not stored yet) | it sends it again; the server answers `duplicate` with the version |
| a pull page received, not stored | it pulls the page again (same cursor) |
| in the middle of a snapshot | the previous state, or no cursor: a new snapshot; the queue is kept |
| between importing the original `localStorage` and removing it | the import is marked; the next start removes it |
| after a 409, before the old id is retired | the intent is stored; the next sync retires it first |
| after signing out, before the database is deleted | nobody is signed in: the start deletes every FieldSync database |

**Tabs** (decision Д-7). The tab that holds a Web Lock named after the user's database leads: it
pushes, pulls and keeps the stream open; the browser releases the lock when the tab closes or
crashes and grants it to the next tab in line (checked in Chromium by crashing the leading tab's
renderer). The others queue their mutations in the database and are told through a
BroadcastChannel to read what the leader stored; messages carry no data and no token and are
checked as untrusted input. The leader reads the queue as stored right before each push, in the
same step as it takes the batch, so a mutation another tab queued meanwhile never leaves a gap.

**Network.** A request is aborted after 30 s (on the client's clock, so tests and the simulation
control it) and on `dispose()`. Retries use exponential backoff with full jitter (a random delay
below a ceiling that starts at 1 s and doubles up to 60 s; AWS Architecture Blog, "Exponential
Backoff And Jitter"), never sooner than a `Retry-After`, reset after a success; the web app syncs at
once on the browser's `online` event. The notification stream is read over `fetch` with
`eventsource-parser`, so it carries the bearer token and the protocol version in headers like every
other request (the browser's `EventSource` can send neither): on `ready` and on every `poke` the
client syncs, a stream silent for three heartbeat intervals is reopened, every reopening waits a
backoff delay. A sync asked for while one runs runs once more after it (F-39). A pull stops at the
head of its first page, and a snapshot is installed once its tail reaches the highest head of its
pages (each page says the head it was read at): under writes faster than a page per request,
neither waits for a page without more changes, which never comes.

**Status.** `indicator`: `synced`, `pending`, `offline`, `rejected` (until the user dismisses the
rejections), plus `loading`, `error` (the storage refuses writes) and `update-required`.

**Recovery from a 409.** A 409 `MUTATION_OUT_OF_ORDER` means the server misses mutations of this
client id that the client no longer has. Renumbering them under the same id could let a late copy of
an old request apply one twice, so the client gives the id up: it stores the intent, retires the id
on the server (`DELETE /sync/clients/:clientId`, owner only; from then on the id applies nothing new,
410 `CLIENT_RETIRED`, while copies of handled mutations still get their results) and continues under
a new id: unsent mutations up to the last id handled under the old one wait for a pull, the others
are renumbered from 1.

**Options considered.** `localStorage` (synchronous, small, no transactions); a client id per tab
(a closed tab's queue is stranded); a SharedWorker owning the queue (missing on Safari before 16 and
Chrome for Android); the `eventsource` package for the stream (it schedules its own reconnect timer
outside the client's clock after every error, which a closed stream cannot cancel).

**NFRs.** No mutation that `mutate` resolved for is lost (RPO 0 for the queue on `strict`
durability); one request at a time per user, whatever the number of tabs.

**Evidence.** Unit tests (`idb-storage.spec.ts` on fake-indexeddb, `tabs.spec.ts` with a property
test over any order of mutations, syncs and tabs closing, `stream.spec.ts`, `backoff.spec.ts`,
`termination.spec.ts`, `versioning.spec.ts`, `dispose.spec.ts`), e2e in Chromium
(`offline-client.spec.ts`, `user-switch.spec.ts`) and the simulation's `reload`, `tab`, `poke` and
`drop-stream` steps.

**Remaining limitations.** Web Locks, BroadcastChannel and IndexedDB are required (all current
browsers, secure contexts only); in some private modes IndexedDB is unavailable and the app says it
cannot work offline. The app asks for persistent storage (`navigator.storage.persist()`); a browser that refuses it may
evict the database under storage pressure (best effort, MDN "Storage quotas and eviction criteria"). Pokes come only
from the server instance that applied the change (fan-out across instances is the observability
change's); a client on another instance learns of it at its next sync. Signing out with unsynced
changes discards them after a confirmation.

### Schema evolution (3.3.7)

**Context.** Clients update later than the server, and an app update must not lose the queue of a
client that was offline. The task asks for a clear "update required" answer to an outdated client
and a local database that migrates without losing its queue.

**Protocol.** Every request carries `FieldSync-Protocol: <integer>`; the server accepts a range
(`SUPPORTED_PROTOCOL`, now 1 to 1) and checks it before authentication, on every sync route and the
stream. A client without the header (every client before versioning) or below the range gets **400**
`CLIENT_UPDATE_REQUIRED` with `details: { min, max }`; one above the range (updated before the
server, during a rolling update) gets 503 `SERVER_UPDATE_REQUIRED` with `Retry-After`. Not 426: RFC
9110 (15.5.22) requires a 426 to name, in an `Upgrade` header, a protocol to switch to on the same
connection (7.8), which an API version is not; the problem code carries the meaning. A client told to
update stores it, makes no more requests and shows `update-required`; its queue waits for the updated
app, which clears the refusal.

**Local schema.** IndexedDB versions with one upgrade step per version in the upgrade transaction
(an interrupted upgrade leaves the old version). Step 0 → 1 creates the stores and imports the
original client's id and last mutation id from `localStorage` (its rows are not imported: the key was
shared by every user, so they cannot be attributed to the one signing in; the client reloads them
from a snapshot); the original keys are removed once the upgrade committed. A tab that holds the
database open when another tab opens a newer version closes it at once (`versionchange`) and asks
for a reload, so the upgrade is never kept waiting by this app.

**Queued mutations.** Each carries the format version of its arguments; a queue written by a newer
app is kept and not sent (the client says it needs the update). The arguments of the first versioned
format are what the server accepts (an edit without `base` is a last-writer-wins edit), so no
upgrader is needed yet.

**Options considered.** URI versions (`/v1/sync/...`, the usual default for HTTP APIs and a mode of
Nest's `enableVersioning`): routes per version, no range, and Nest answers an unknown version with
404, not "update required". No versions: an outdated client retries forever (the client before the log
lifecycle change does that on 410).

**Evidence.** `protocol-version.spec.ts` (every route and the stream, below, above, malformed, health
not checked), `versioning.spec.ts`, `idb-storage.spec.ts` (import, interrupted import, `versionchange`,
`blocked`), e2e "moves the original client's id from localStorage into the database".

**Remaining limitations.** A client before versioning (the original one) cannot understand the
answer: it shows offline and retries; only a reload with the new app helps. The first local schema
has a single upgrade step; the mechanism for the next ones is in place, their tests come with them.

## Found issues

Each issue has an id (in the order the issues were found), the category from the task (1 delivery
order and completeness, 2 retried and parallel pushes, 3 rejection in the middle of the queue, 4
authenticity and access, 5 change-log lifecycle, 6 resources not released, 7 determinism across
environments, 8 client data loss, 9 merging concurrent edits, 10 tests that pass regardless of the
behaviour they name; "other" for everything else), a test that reproduces it, and the commits that
reproduce and fix it.

| Id | Category | Issue | Status |
|---|---|---|---|
| F-01 | 10 | Pull access test mocked every query | Fixed |
| F-02 | 10 | Mutator rejection tests could not fail | Fixed |
| F-03 | 10 | Sequential-numbering test never looked at the ids | Fixed |
| F-04 | 10 | Access tests pinned trust in the client's `siteId` | Fixed |
| F-05 | 10 | The only integration test was `SELECT 1`, and could be skipped silently | Fixed |
| F-06 | 10 | `it.todo` tests named behaviour nothing checked | Fixed |
| F-07 | 4 | Incremental pull returns other sites' changes | Open (known defect) |
| F-08 | 4 | Write access is checked against the `siteId` the client sends | Open (known defect) |
| F-09 | 2 | Client reuses a mutation id after a rejection | Fixed |
| F-10 | 8 | Pending mutations and the list of rejections are lost on reload | Fixed |
| F-11 | 8 | Two tabs sharing a `clientId` lose each other's mutations | Fixed |
| F-12 | 3 | Mutator names from `Object.prototype` crash the push | Fixed |
| F-13 | 6 | A request that never answers blocks syncing forever | Fixed |
| F-14 | other | A failed rollback replaces the original error | Fixed |
| F-15 | other | A dropped database connection crashes the server | Fixed |
| F-16 | other | Unvalidated settings: an invalid GC interval runs the GC every millisecond | Fixed |
| F-17 | other | Docker images run as root and bake in local `.env` files; no migrate step, no healthchecks | Fixed |
| F-18 | other | CI was not reproducible and did not typecheck the web app | Fixed |
| F-19 | 7 | `ticket.create` makes up its own id, so the client, every recomputed view and the server use different ids | Fixed |
| F-20 | 7 | Mutators stamp rows with the clock of whatever environment runs them | Fixed |
| F-21 | 7 | Mutators accept arguments the server cannot store | Fixed |
| F-22 | 7 | Queued mutations keep a live reference to the caller's arguments | Fixed |
| F-23 | 3 | A rejected mutation fails the whole push with HTTP 500 | Fixed |
| F-24 | other | Adding a part under a taken id is reported as applied | Fixed |
| F-25 | 1 | A change that commits after a later one is never delivered | Fixed |
| F-26 | 2 | Parallel copies of one mutation are applied several times; a retried rejection loses its reason | Fixed |
| F-27 | 9 | An edit of one ticket field overwrites another client's edit of the other field | Fixed |
| F-28 | 3 | A batch of long mutations is refused with 413 on every retry, blocking the queue | Fixed |
| F-29 | other | Unvalidated pull parameters and client ids: silent full resyncs and 500s | Fixed |
| F-30 | 8 | An applied mutation disappears from the view when the sync is interrupted before its change arrives | Fixed |
| F-31 | 9 | Deleting a ticket leaves its parts behind, and a concurrent part edit still applies | Fixed |
| F-32 | 8 | After a reload, a new mutation reuses an id the server already handled and is dropped as a duplicate | Fixed |
| F-33 | 4 | A client id is not bound to its user: another user can push under it and take the owner's next mutation id | Open (known defect) |
| F-34 | 5 | The GC deletes the change log by age without a signal: stale clients skip changes, new clients miss entities, and the log gets holes | Fixed |
| F-35 | 6 | Notification streams stay subscribed after their connection closes, and an idle stream gets no heartbeat | Fixed |
| F-36 | 6 | Open notification streams keep the server from shutting down | Fixed |
| F-37 | 6 | The web app never closes its client and stream; a disposed client keeps its request and writes its state | Fixed |
| F-38 | 8 | A write the browser storage refuses is ignored, and the client shows itself as synced | Fixed |
| F-39 | 1 | A notification that arrives while a sync is running is lost (found after the protocol change) | Fixed |
| F-40 | 4 | A user who signs in after another in the same browser sees the other's data and pushes under their client id | Fixed |

### F-01: pull access test mocked every query (category 10)

- **What.** `apps/server/test/pull.spec.ts`, "only returns changes for sites the user can access",
  mocked the database so that every query returned no rows, then asserted an empty result.
- **Why it is dangerous.** No implementation can fail it: with all data mocked away, a pull that
  ignores access entirely still returns nothing. The suite reported the access rule as tested
  while it was broken (F-07).
- **Reproduce.** `scripts/audit-starter-tests.sh` removes the site filter from the pull query: the
  starter test still passes, the replacement fails.
- **Fix.** Replaced by `apps/server/test/integration/pull-access.spec.ts` on a real database: the
  initial pull is filtered by site (passes) and the incremental pull is filtered by site (known
  defect F-07).
- **Alternatives.** A smarter mock that evaluates the `WHERE` clause would re-implement SQL in the
  test and test the mock; the rule lives in SQL, so it is tested against Postgres.
- **Commits.** `1bac9ad`.

### F-02: mutator rejection tests could not fail (category 10)

- **What.** In `packages/sync-core/test/mutators.spec.ts`, "rejects an invalid status transition"
  called the mutator inside `try/catch` with the assertion in the `catch` and no assertion count;
  the other rejection tests accepted any `MutationRejected`.
- **Why it is dangerous.** If the transition were allowed, nothing would throw and the test would
  pass. A rejection with the wrong code (e.g. `BAD_ARGS` instead of `NEGATIVE_QUANTITY`) would
  also pass, although clients act on the code.
- **Reproduce.** The audit script allows `done → in_progress`: the starter test passes, the
  replacement fails.
- **Fix.** Every rejection test requires the exact code and checks that the state did not change;
  "creates a ticket" also checks that exactly one row was written.
- **Alternatives.** `expect.assertions(1)` alone would fix the first test but not the missing code
  and state checks.
- **Commits.** `9766718`.

### F-03: sequential-numbering test never looked at the ids (category 10)

- **What.** "numbers local mutations sequentially" in `packages/sync-core/test/client.spec.ts`
  checked the number of rows and pending mutations only; "shows a locally created ticket" checked
  only the row count.
- **Why it is dangerous.** Mutation ids are how the server deduplicates and orders a client's
  writes; with every id equal to 1 the test still passed.
- **Reproduce.** The audit script makes every id 1: the starter test passes, the replacement fails.
- **Fix.** A recording transport captures what the client pushes; the test expects `[1, 2, 3]`.
  The optimistic-create test checks the row content. A stricter property, that ids are never
  reused even after a rejection, is known defect F-09.
- **Commits.** `a96263e`.

### F-04: access tests pinned trust in the client's `siteId` (category 10)

- **What.** `apps/server/test/access.spec.ts` used a fake database that returned the same rows for
  any query and ignored the role; "rejects a mutation on a site the user cannot access" only
  varied the `siteId` argument.
- **Why it is dangerous.** The test name promises a check against the site the user cannot access,
  but it confirmed that the argument decides, which is the defect (F-08). The admin branch was
  untested.
- **Reproduce.** The audit script removes the admin branch: the starter tests pass, the new ones
  fail.
- **Fix.** The unit tests are renamed to what they check (the `siteId` argument), the fake answers
  each query by table and user, and admin and missing-`siteId` cases are added. The real property
  (checked against the stored row's site) is tested on Postgres as known defect F-08.
- **Commits.** `9edc67e`.

### F-05: the only integration test was `SELECT 1` (category 10)

- **What.** `apps/server/test/sync.integration.spec.ts`, suite "sync protocol (integration)", ran
  `SELECT 1`. Without `DATABASE_URL` it was skipped, so CI was green with no integration test run
  if the variable was ever missing.
- **Why it is dangerous.** The protocol had no test on a real database at all; the categories that
  need one (ordering, idempotency, access) were untested.
- **Reproduce.** The audit script makes push report every mutation as a duplicate: `SELECT 1` passes,
  the characterization suite fails.
- **Fix.** A harness with a database per test file, the real app on an ephemeral port and fixtures
  (`d9d4b23`); characterization tests of authentication, `/me`, push, pull, duplicates,
  out-of-order ids, malformed bodies, status/part/tombstone changes, atomicity of a rejected
  mutation, paging and the GC (`a9c598a`). `REQUIRE_DB=1` makes a missing database a failure.
- **Commits.** `d9d4b23`, `a9c598a`.

### F-06: `it.todo` tests named behaviour nothing checked (category 10)

- **What.** "keeps unsynced mutations across a reload" and "does not lose mutations when two tabs
  share one clientId" were `it.todo`.
- **Why it is dangerous.** They read like a specification but never run, and both behaviours are
  broken (F-10, F-11).
- **Fix.** Both are real tests now, tracked as known defects F-10 and F-11.
- **Commits.** `f943f8d`.

### F-07: incremental pull returns other sites' changes (category 4)

- **What.** `PullService.pull` filters by the user's sites only when `cursor` is 0; every later
  pull returns changes of every site.
- **Why it is dangerous.** Any technician receives every site's tickets after the first sync.
- **Reproduce.** `pull-access.spec.ts`, "incremental pull returns only changes for sites the user
  can access" (known defect); in the simulation, the signature `foreign-site-rows` in the
  `multi-site` and `full` profiles.
- **Fix.** Not fixed yet; owned by the access-control change. **Commits.** `1bac9ad` (test).

### F-08: write access is checked against the `siteId` the client sends (category 4)

- **What.** `authorize` checks `mutation.args.siteId`, not the site of the row the mutation
  changes.
- **Why it is dangerous.** A technician of North can change the status of a South ticket, or add a
  part to it, by sending `siteId: North`.
- **Reproduce.** `write-access.spec.ts`, two known-defect tests.
- **Fix.** Not fixed yet; owned by the access-control change. **Commits.** `9edc67e` (tests).

### F-09: client reuses a mutation id after a rejection (category 2)

- **What.** `SyncClient.mutate` derives the id as `lastMutationId + pending.length + 1`. When the
  server rejects a mutation without advancing `lastMutationId`, the queue shrinks and the next
  mutation gets the rejected id.
- **Why it is dangerous.** The server treats the new mutation as a duplicate and drops it.
- **Reproduce.** `client.spec.ts`, "never reuses a mutation id after the server rejects a
  mutation".
- **Fix.** Ids come from a counter that only grows: each `mutate` takes the next one, and an answer
  of the server can only move the counter past its last applied id, never back. The server now
  advances its last mutation id for a rejected mutation too (F-23), so both sides agree on which
  ids are used. Within one page load the counter is exact; across reloads it restarts after the
  stored last applied id, which is safe only once the queue itself survives a reload (F-10).
- **Alternatives.** Keeping the formula and relying on the server advancing its id on rejection:
  any answer that removes a mutation from the queue before the id catches up (a lost response, a
  future server) would reuse an id again. Random ids per mutation: the server could no longer tell
  a gap from a duplicate, and ordering would need another field.
- **Commits.** `1a3c31e` (test), `9df3a24` (fix).

### F-10: pending mutations are lost on reload (category 8)

- **What.** The client persisted the server's rows and its cursor (in `localStorage`) but not its
  queue, and kept the list of rejected mutations only in memory.
- **Why it is dangerous.** Work done offline disappears when the page reloads, and so does the
  reason a change was refused: the user cannot tell that it never reached the server.
- **Reproduce.** `client.spec.ts`, "keeps unsynced mutations across a reload" (a known defect from
  the start); `idb-storage.spec.ts`, "serves a client across a reload"; e2e `offline-client.spec.ts`,
  "keeps changes made without the server across a reload".
- **Fix.** The client's whole state (meta, rows, queue, rejections) is in its storage, IndexedDB in
  the browser (`IdbSyncStorage`, through `idb`), and every change of it is one transaction. A
  mutation is shown once it is stored (see [3.3.3](#offline-first-client-333)).
- **Alternatives.** The queue in `localStorage` next to the state: synchronous, a few megabytes for
  every origin, no transactions across keys, shared by every tab without any coordination. A queue
  kept in memory and written on `beforeunload`/`pagehide`: browsers do not guarantee those events
  (a crash, a killed mobile tab).
- **Commits.** `f943f8d` (test), `373c2a8` (fix).

### F-11: two tabs sharing a `clientId` lose each other's mutations (category 8)

- **What.** Tabs shared `clientId` and storage but allocated mutation ids in memory, so both used
  id 1 and the server dropped the second as a duplicate.
- **Why it is dangerous.** A user with two tabs open loses changes without any message.
- **Reproduce.** `client.spec.ts`, "does not lose mutations when two tabs share one clientId" (a
  known defect from the start); `tabs.spec.ts` (a property test over any order of mutations, syncs
  and tabs closing); e2e "lets two tabs of one user work at once".
- **Fix.** The storage gives a mutation its id in the transaction that queues it, so ids are unique
  however many tabs queue (`373c2a8`); and one tab talks to the server for all of them (Web Locks and
  BroadcastChannel, `298850b`), reading the queue as stored right before each push, so it never sends
  a batch with a gap in the ids.
- **Alternatives.** A client id per tab: the server would see every tab as its own device, and a
  closed tab's queue would be stranded. A SharedWorker owning the queue: not available in Safari
  before 16 or on Chrome for Android.
- **Commits.** `f943f8d` (test), `373c2a8`, `298850b` (fix).

### F-12: mutator names from `Object.prototype` crash the push (category 3)

- **What.** The server looks mutators up with `MUTATORS[name]` on a plain object. `toString`,
  `constructor`, `__proto__` and `hasOwnProperty` pass the "unknown mutator" check and then fail
  with a `TypeError`.
- **Why it is dangerous.** The whole push answers 500, so the client retries the same batch
  forever; even with rejections handled, such a mutation would be reported as an internal error
  rather than `UNKNOWN_MUTATOR`.
- **Reproduce.** `mutator-lookup.spec.ts`.
- **Fix.** `mutatorNamed(name)` in `sync-core` counts only the table's own entries
  (`Object.hasOwn`), with `isMutatorName` as a type guard; the server rejects any other name with
  `UNKNOWN_MUTATOR`. The push body's DTO accepts any name up to 64 characters, so an unknown name
  rejects its own mutation, not the batch.
- **Alternatives.** A `Map` of mutators: the same safety, but the table is also the typed
  `Record<MutatorName, MutatorDef>` the client uses. `Object.create(null)` for the table: hides the
  problem in one object instead of fixing the lookup.
- **Commits.** `791bd98` (test), `009d032` (fix).

### F-13: a request that never answers blocks syncing forever (category 6)

- **What.** `HttpTransport` had no timeout or abort signal; sync attempts are deduplicated, so
  while one request hung no other was made.
- **Why it is dangerous.** After a half-open connection the client shows "syncing" forever and
  never pushes again until the page reloads.
- **Reproduce.** `client.spec.ts`, "gives up on a request that never answers and retries" (a known
  defect from the start); the simulation's `hang` fault (the signature `stuck-request` in `full`).
- **Fix.** Every request gets an abort signal; it is aborted after `requestTimeoutMs` (30 s by
  default) on the client's clock, fails as `TIMEOUT` and is retried with backoff. The simulation no
  longer tolerates `stuck-request`; a client without a timeout still produces it (checked).
- **Alternatives.** `AbortSignal.timeout()`: real time, which the simulation and the tests cannot
  control.
- **Commits.** `22b61c2` (test), `c1605bb` (fix).

### F-14: a failed rollback replaces the original error (other)

- **What.** In `Db.tx`, when the callback failed and `ROLLBACK` failed too (the connection was
  gone), the caller received the rollback's error ("Client has encountered a connection error and
  is not queryable") instead of the one that caused the rollback.
- **Why it is dangerous.** The cause of the failure is lost, and code that reacts to specific
  errors (a rejected mutation, a serialization failure) sees a different one.
- **Reproduce.** `transactions.spec.ts`, "reports the original error when the rollback after it
  fails".
- **Fix.** `Db.tx` on a TypeORM `QueryRunner` logs a failed rollback and rethrows the original
  error; broken connections are discarded, not reused.
- **Alternatives.** Wrapping both errors in an `AggregateError` would keep both but change the
  error type every caller sees.
- **Commits.** `f94fa7f` (test), `291d9bb` (fix).

### F-15: a dropped database connection crashes the server (other)

- **What.** Neither the `pg` pool nor the clients checked out by `Db.tx` had an `error` listener.
  When Postgres terminated a connection (restart, failover, an idle-session timeout), `pg` emitted
  `error` with nobody listening and the Node process exited.
- **Why it is dangerous.** One dropped connection takes the whole API down for every user; with
  idle connections in the pool this happens on any database restart.
- **Reproduce.** `connection-loss.spec.ts`: terminating the server's idle connections, and
  terminating its connection while a push waits for a row lock.
- **Fix.** The TypeORM pool and query runners listen for connection errors: the affected request
  fails (500), the server keeps serving, and the transaction leaves no partial write.
- **Commits.** `c0229d5` (test), `291d9bb` (fix).

### F-16: unvalidated settings (other)

- **What.** Settings were read as `Number(process.env.X ?? default)`. `GC_INTERVAL_MS=1h` became
  `NaN`, which `setInterval` treats as 1 ms: the server ran the change-log `DELETE` about once per
  millisecond (126 runs in 100 ms in the test). An invalid `PORT` or retention behaved similarly
  badly; nothing was reported.
- **Reproduce.** `config.spec.ts` (integration), "refuses to start with a non-numeric GC interval
  instead of collecting every millisecond"; unit tests in `apps/server/test/config.spec.ts`.
- **Fix.** A validated, typed configuration loaded once at startup; invalid values stop the server
  with a readable report (see [Configuration](#configuration)).
- **Alternatives.** Joi as `validationSchema` (the other approach the `@nestjs/config`
  documentation shows; another dependency next to `class-validator`, which the request DTOs use
  anyway), or a hand-written loader (what the fix first was; replaced by `@nestjs/config` to follow
  the framework's documented approach, see [Server configuration](#server-configuration)).
- **Commits.** `6312140` (test), `84c1a44` (fix).

### F-17: Docker images (other)

- **What.** Both images ran as root, copied the whole package directories (including any local
  `.env`, `node_modules` and build output) because there was no `.dockerignore`, installed
  without a lockfile, and shipped dev dependencies. Compose had no migration step and no
  healthchecks; `web` started as soon as the server container existed.
- **Why it is dangerous.** Secrets from a developer's `.env` end up in image layers; a compromised
  process has root in the container; builds are not reproducible.
- **Reproduce.** `scripts/docker-smoke.sh` (it plants canary `.env` files). On the original setup
  it reports: both images run as root, both contain `.env` files, no migrate step, no
  healthchecks.
- **Fix.** `.dockerignore`; multi-stage builds with `npm ci`; runtime stages with production
  dependencies (server) or the Next.js standalone output (web), running as `node`, with
  healthchecks; compose runs `migrate` before the server and starts web when the server is healthy.
- **Commits.** `25302fc` (check), `0c80ddb` (fix).

### F-18: CI was not reproducible and did not typecheck the web app (other)

- **What.** There was no lockfile and CI ran `npm install`, so each run could resolve different
  dependency versions; `npm run typecheck` skipped `apps/web`; the only custom lint rule was a
  warning, and warnings never failed CI.
- **Reproduce.** `npm ci` fails on the original repository (no lockfile).
- **Fix.** The lockfile is committed and CI runs `npm ci`; typecheck covers every package; lint uses
  type information (unhandled promises, unsafe `any`, exhaustive switches) and fails on warnings;
  formatting is checked with Prettier; CI is split into lint/format/typecheck/unit/build,
  integration (Postgres 16, `REQUIRE_DB=1`), e2e and docker jobs.
- **Commits.** `6472816`, `c07f58e`, `b67ea1e`, `7024909`.

### F-19: `ticket.create` makes up its own id (category 7)

- **What.** The mutator called `crypto.randomUUID()` itself. The client ran it once per
  recomputation of its optimistic view and the server ran it once more, so every run produced a
  different id.
- **Why it is dangerous.** An optimistic ticket changed its id on every render, so its link broke
  at once; edits and parts added to it before the first sync named an id the server never stored
  and were rejected (`NOT_FOUND`); after the sync the ticket "jumped" to the server's id.
- **Reproduce.** `mutators.spec.ts` ("creates the ticket under the id the client chose", "writes
  the same ticket every time…"), `client.spec.ts` ("keeps an optimistic ticket under the id the
  caller chose"), `client-ids.spec.ts` ("stores a created ticket under the id the client chose").
  With the old behaviour put back, the property tests in `determinism.spec.ts` fail on a minimal
  `ticket.create`, and so does a baseline simulation seed (`detection.spec.ts`).
- **Fix.** `ticket.create` takes a required UUID `id` that the caller generates before queueing
  (the web app uses `crypto.randomUUID()`). Because ids now come from the client, the server must
  never let one id name two rows: creates go through a new `MutatorTx.insert`, which the server
  executes as `INSERT … ON CONFLICT DO NOTHING RETURNING` and rejects with `ID_CONFLICT` when the id
  is taken by a live row, a deleted row (tombstone) or a concurrent insert (it waits for that
  transaction and then sees the conflict). The original upsert would have let a create overwrite
  another site's ticket or revive a deleted one; `client-ids.spec.ts` checks both and 20 rounds of
  two concurrent creates with one id (exactly one applies).
- **Alternatives.** A temporary client id that the server maps to a real one: every later queued
  mutation that names the ticket would need rewriting. Catching the unique violation (23505)
  instead of `DO NOTHING`: the error aborts the transaction, so it needs a savepoint around every
  insert. A `SELECT … FOR UPDATE` existence check: it locks nothing when the row does not exist yet,
  so two concurrent creates both pass it.
- **Protocol change.** `ticket.create` requires `id`. Until rejections are reported per mutation
  (F-23), an `ID_CONFLICT` still fails the push with 500, but nothing is written.
- **Commits.** `6d3bf48` (test), `5120e40` (fix).

### F-20: mutators stamp rows with the clock of whatever environment runs them (category 7)

- **What.** `createdAt` and `updatedAt` came from `new Date()` inside the mutators. On the server, a
  row's data took the Node clock while its change-log entry (`created_at DEFAULT now()`) and the GC
  cutoff took Postgres's clock.
- **Why it is dangerous.** The optimistic row changed its timestamps on every recomputation of the
  view; the client and the server stored different times for one change; two clocks on one server
  disagree under skew; and nothing could be driven by a test clock.
- **Reproduce.** `mutators.spec.ts` ("takes the timestamps … from the transaction"), `client.spec.ts`
  ("keeps the timestamps of an optimistic ticket stable…"), `server-clock.spec.ts` ("stamps a
  mutation's row and its log entry with one server clock"), and the property tests in
  `determinism.spec.ts`, which run every mutator with `Math.random`, `Date` and `crypto` stubbed
  out. With the old behaviour put back into `ticket.create`, one simulation seed gives two
  different traces (`detection.spec.ts`).
- **Fix.** `MutatorTx.now()`: on the client, the time the mutation was queued, kept with it; on the
  server, a new `Clock` provider (`SystemClock` in production), read once per mutation and also used
  for `change_log.created_at` and the GC cutoff. An ESLint override forbids `Date`, `crypto`,
  `performance`, `globalThis`, timers and `Math.random()` in the mutators file
  (`mutator-lint.spec.ts` checks that the rules report each of them).
- **Alternatives.** The client sends its own time and the server keeps it: client clocks are wrong
  and untrusted. Postgres `now()` everywhere: the mutator runs in Node and would need the time passed
  in anyway, and `now()` is the transaction's start time.
- **Commits.** `b8479c4` (test), `7f88005` (fix), `abafac7` (lint rules).

### F-21: mutators accept arguments the server cannot store (category 7)

- **What.** Ids were checked as UUIDs only on the server (`assertUuids`), not by the shared
  mutators; text could contain NUL or an unpaired UTF-16 surrogate, which Postgres refuses in
  `text` and `jsonb`; and `description.slice(0, 5000)` could cut an emoji in half, leaving exactly
  such a surrogate.
- **Why it is dangerous.** The client applies the mutation optimistically while the server fails
  on it (a database error, so HTTP 500): the user sees a change that can never be stored, and the
  push fails every time it is retried.
- **Reproduce.** `arguments.spec.ts` (every mutator, every id field, NUL and both kinds of unpaired
  surrogate, the cut at the limit) and `unstorable-arguments.spec.ts` on Postgres (a rejection, not
  a `QueryFailedError`).
- **Fix.** The shared mutators check their id arguments as UUIDs and reject unstorable text with
  `BAD_ARGS`: NUL, or a string that is not well-formed UTF-16 (`String.prototype.isWellFormed`,
  built into Node.js 20; the web app imports the `core-js` polyfill for it, since Next.js 14 supports
  browsers that lack it and does not polyfill it). Long descriptions are still cut to 5000 UTF-16
  units, but never between the halves of a surrogate pair.
- **Alternatives.** Silently strip NUL and replace unpaired surrogates (`String.prototype.toWellFormed`):
  it changes what the user typed without telling them. A hand-written surrogate scan instead of
  `isWellFormed`: more code for the same check, which the standard method already does.
- **Commits.** `376c8ca` (test), `60ffa0b` (fix), `e0018cf` (`isWellFormed`).

### F-22: queued mutations keep a live reference to the caller's arguments (category 7)

- **What.** `SyncClient.mutate` queued the `args` object itself.
- **Why it is dangerous.** A caller that changes the object afterwards changes the optimistic view
  but not what the server receives (it was serialised when the push started), so the client and
  the server apply different arguments. A value JSON cannot encode (a `BigInt`) made every push
  throw, so the whole queue stayed offline behind it.
- **Reproduce.** `client.spec.ts`, "queues the arguments as they were when mutate was called" and
  "refuses arguments that cannot be sent instead of blocking the queue behind them".
- **Fix.** `mutate` queues and applies a JSON round trip of the arguments, exactly what the server
  will receive, and throws a `TypeError` without queueing anything when they cannot be serialised.
- **Alternatives.** `structuredClone`: it keeps `Date`, `Map` and `BigInt` values that JSON would
  change or reject, so the client would still apply different values than the server. Freezing the
  caller's object: surprising for the caller, and not what the server receives either.
- **Commits.** `a409b2c` (test), `15551bf` (fix).

### F-23: a rejected mutation fails the whole push with HTTP 500 (category 3)

- **What.** `PushService` does not catch `MutationRejected`: any mutation the mutator rejects
  (`STATUS_CONFLICT`, `NOT_FOUND`, `NEGATIVE_QUANTITY`, `BAD_ARGS`, `ID_CONFLICT`, …) makes the push
  answer 500, and the client's last mutation id does not advance.
- **Why it is dangerous.** The client never learns the reason and retries the same batch forever;
  every mutation queued after the rejected one is blocked (a poison mutation).
- **Reproduce.** `rejections.spec.ts` and `client-ids.spec.ts` ("tells the client that a create
  was rejected with ID_CONFLICT"), known defects until the fix; in the simulation, the signature
  `rejected-mutation-500` in the `rejections` and `full` profiles, which no longer tolerate it (see
  [Simulation](#simulation)).
- **Fix.** Each mutation's transaction runs the mutator inside a savepoint. A rejection rolls back
  to it, which undoes the mutator's writes and the locks they took, and the same transaction then
  advances the client's last mutation id, exactly as an application does: the rejected mutation is
  final, and the ones after it are applied. The answer names the reason:
  `{ id, status: 'rejected', code, message, details? }` (codes and details in
  [3.3.5](#merge-semantics-335)), and the client drops the mutation from its queue and keeps the
  rejection for the user. The characterization test "leaves no trace of a mutation that the mutator
  rejects" changed with this fix: it pinned the 500 behaviour (last mutation id left at 1) and now
  expects the rejection in the answer and the id advanced. In the simulation, rejections are checked
  by code: a profile may only see the codes its actions can cause (`unexpected-rejection`).
- **Alternatives.** Rolling back the whole batch: one bad mutation would still block every other
  one. A transaction per mutation without a savepoint, recording the rejection in a second
  transaction: between the two, a retried copy of the mutation could run again. Answering 4xx for
  the batch: the client could not tell which mutation was refused.
- **Commits.** `34047d5` (test), `5120e40` (`ID_CONFLICT` test), `c0e1b7d` (simulation corpus),
  `3c0b884` (rejection format), `78ef268` (savepoints), `0abb406` (fix).

### F-24: adding a part under a taken id is reported as applied (other)

- **What.** `part.add` returned early when a part with the given id existed, so the push reported
  the new part as applied without storing it.
- **Why it is dangerous.** The part the user entered disappears after the next pull, silently; with
  a deleted part's id the upsert would have revived the part, possibly in another site.
- **Reproduce.** `mutators.spec.ts`, "rejects a part whose id is already taken…", and
  `client-ids.spec.ts`, "does not report a part as added when its id already names another part".
- **Fix.** `part.add` writes through `MutatorTx.insert` like `ticket.create`: a taken id (also a
  deleted part's) is rejected with `ID_CONFLICT`. Retried pushes are deduplicated by mutation id, so
  the early return was not needed for idempotency.
- **Commits.** `dec7ec0` (test), `dfe8082` (fix).

### F-25: a change that commits after a later one is never delivered (category 1)

- **What.** A change-log version came from the `bigserial` sequence when the row was inserted, not
  when its transaction committed. A transaction that took version 5 and committed after the one
  that took 6 was invisible to a pull that ran in between; that pull answered `nextCursor = 6`, and
  the next pull asked for versions after 6.
- **Why it is dangerous.** The change is never delivered to that client: it silently diverges from
  the server until it reloads everything. Any two concurrent pushes can cause it.
- **Reproduce.** `commit-order.spec.ts`, "delivers a change that commits after a change with a later
  position in the log": the test's own connection holds an uncommitted row with the id a ticket
  create is about to insert, so the create waits inside its transaction after taking its version
  while a second create commits; no hook in the server.
- **Fix.** Versions come from a one-row table, `log_head` (decision record
  [3.3.1](#protocol-correctness-331)). Appending to the change log is the last statement of every
  writing transaction: one statement takes the next versions from the head (locking its row until
  the transaction ends), inserts the log rows and stamps the changed entities. Every writer holds
  the head from that statement to its commit, so versions are assigned and become visible in commit
  order and without gaps; a reader can never see version 6 before 5. All other locks (the client's
  row, the entity rows in key order) are taken before, so the head is held only for the end of the
  transaction. The migration starts the head after the last version the sequence handed out (rows of
  rolled-back inserts or the newest rows removed by the GC may have taken one, and a client may hold
  it as its cursor) and drops the sequence. Also covered by a stress test: 16 writers and 4 readers
  paging with small pages, every reader sees every version exactly once and in order.
- **Alternatives.** See the decision record: an advisory lock with the sequence, a commit-time
  watermark with `xid8` (`pg_snapshot_xmin`), or keeping the sequence and making readers stop below
  the oldest running writer.
- **Commits.** `4f9f4d9` (test), `4dd4f9e` (fix).

### F-26: parallel copies of one mutation are applied several times (category 2)

- **What.** `PushService` read the client's last applied mutation id with a separate query, outside
  the transaction that applied the mutation and without a lock. Copies of one push that arrive at
  the same time all read the same id and all apply the mutation. A copy that arrived after a
  rejection was answered `duplicate`, without the reason.
- **Why it is dangerous.** Retries are normal for an offline-first client (a lost answer, a flaky
  network delivering a request twice): of 50 copies of `part.adjust (+1)` pushed at once about 20
  were applied, so the quantity grew by 20. A client whose first answer was lost never learns why
  its mutation was refused.
- **Reproduce.** `duplicates.spec.ts`: 50 parallel copies in each of 100 rounds, overlapping
  batches of one client, parallel and retried copies of a rejected mutation.
- **Fix.** The mutation's transaction first locks the client's row (`SELECT … FOR UPDATE`, creating
  it on the first push) and reads the last applied id there, so copies and different mutations of
  one client run one after another and each sees what the previous one committed. The mutator runs
  in a savepoint taken after the lock (rolling back to it keeps the lock, PostgreSQL 13.3.2). The
  outcome of every mutation is stored in `mutation_results` in the same transaction; a copy of a
  handled mutation is answered with it: the rejection with its code and details, or `duplicate`
  for an applied one. `clients.user_id` now references `users`. Results live as long as the change
  log (the GC deletes both by the same cutoff); a copy older than that is answered `duplicate`, and
  its client has to reload anyway.
- **Alternatives.** A unique key on `(client_id, mutation_id)` alone: it stops the second
  application only when the insert of the key comes before the mutation's writes, and the loser's
  answer still has no reason. An advisory lock per client: the same serialisation as the row lock,
  but outside the data and easy to forget in another code path. Serializable isolation: correct,
  but a conflict becomes a retry of the whole transaction, and retries are what caused the problem.
- **Commits.** `e5831da` (test), `9755602` (fix).

### F-27: an edit of one ticket field overwrites another client's edit of the other field (category 9)

- **What.** `ticket.update` always wrote both the title and the description, with the values the
  user's form held. Two technicians who edit the same ticket offline, one the title and one the
  description, sync in some order, and the second sync writes back the first one's field as it was
  before. An edit of one field alone was refused (`title` was required) or emptied the description.
- **Why it is dangerous.** A confirmed edit is lost silently, on every client and the server. The
  convergence check cannot see it: every client loses the same edit, so they all still converge.
- **Reproduce.** `merge.spec.ts`. In the simulation, the property "no lost edits" reports it as
  `lost-edit` (`detection.spec.ts` puts the original behaviour back).
- **Fix.** An edit names only the fields the user changed, with `base`: the value each had on the
  user's screen (`ticketEdit()` in `sync-core` builds it; the ticket page and the simulation use it).
  Edits of different fields merge. An edit of a field someone else changed since is rejected with
  `FIELD_CONFLICT`, naming for each such field the value it has now and the one the user typed, so
  the user can keep either (decision record [3.3.5](#merge-semantics-335)). An edit without `base`
  writes its fields (the last write in server order wins), so mutations queued by the original
  client still apply. The simulation's edits change one field or both, and the profiles allow
  `FIELD_CONFLICT` as a legitimate rejection.
- **Alternatives.** Last writer wins per field without a base: different fields merge, but of two
  edits of the same field one disappears without anybody being told, which the task asks to avoid.
  A version per ticket (optimistic locking of the row): edits of different fields would conflict
  too. Merging text (operational transform, CRDT): out of scope (task, section 9).
- **Commits.** `b9d7f5e` (test), `bcff851` (fix), `ec2ef0a` (simulation property).

### F-28: a batch of long mutations is refused with 413 on every retry (category 3)

- **What.** The client put up to 100 mutations in one push whatever their size, and the server kept
  Express's default JSON body limit of 100 KB. Ten tickets with a 5000-character description are
  already more than that.
- **Why it is dangerous.** The server refuses the whole body with 413 before any mutation runs; the
  client retries the same batch forever, so everything queued behind it never reaches the server
  (the same poison effect as F-23, for valid mutations).
- **Reproduce.** `body-limit.spec.ts`, "accepts a push body as large as the client sends", and
  `push-batches.spec.ts`, "splits a queue of long mutations into bodies the server accepts, in order".
- **Fix.** The protocol fixes the largest push body (`MAX_PUSH_BODY_BYTES`, 1 MiB of UTF-8 JSON, in
  `sync-core`). The client splits its queue into bodies of at most 100 mutations and that many
  bytes, and `mutate` refuses a single mutation that could never fit (a `TypeError`, like an
  unsendable value in F-22). The server's JSON limit is `JSON_BODY_LIMIT_BYTES` (2 MiB by default,
  never below the protocol's 1 MiB), set with `app.useBodyParser` as the NestJS documentation
  describes; a larger body is still a 413 and applies nothing.
- **Alternatives.** Only raising the server limit: the largest valid batch is about 3 MB (control
  characters take six bytes each in JSON), and any fixed limit can be exceeded by a long enough
  queue. Only fewer mutations per batch: the count does not bound the bytes. Skipping a mutation
  the server refuses for its size: it would be lost although it is valid.
- **Commits.** `acf00e3` (test), `360a4fe` (fix).

### F-29: unvalidated pull parameters and client ids (other)

- **What.** Pull read `cursor` and `limit` with `Number(x) || 0`: `cursor=abc` became 0, a full
  resync from the start of the log, and `-5`, `1e3` or a repeated parameter were accepted too;
  `cursor=1.5`, `limit=1.5` and values beyond `bigint` reached Postgres and failed with 500. Push and
  pull took any string as the client id, so one with a NUL character (which Postgres cannot store)
  failed with 500.
- **Why it is dangerous.** The server must not trust its input (task, section 4): a malformed
  request silently changes what the client receives, or turns into a server error that hides the
  client's bug.
- **Reproduce.** `request-validation.spec.ts`.
- **Fix.** `PushRequestDto` and `PullQueryDto` are checked by the global `ValidationPipe`: decimal
  integers only (the same conversion as the settings, so `1e3` and `""` are refused), cursors and
  mutation ids up to 2^53 − 1 (the integers JSON numbers carry exactly), a page of 1 to 500 changes,
  and UUID client ids, which is what every client generates. Anything else is a 400. The mutator
  arguments are not part of the DTO check: they reach the mutator untouched and are validated there,
  in the code the client runs too, so one bad argument rejects only its own mutation.
- **Alternatives.** `ParseIntPipe` per parameter: it checks the digits but no range, and has no
  answer for the client id. `enableImplicitConversion`: turns `""` into 0 and `1e3` into 1000.
  Clamping an out-of-range `limit` instead of refusing it: hides the client's mistake.
- **Commits.** `0432efb` (test), `6b19648` (fix).

### F-30: an applied mutation disappears from the view when the sync is interrupted (category 8)

- **What.** The client dropped a mutation from its queue as soon as the push answered that it was
  applied, and again as soon as any pull page reported a last mutation id covering it, even when
  the change itself was still on a later page. Its optimistic view is the pulled state plus the
  queue, so until a later pull delivered the change the user's edit was gone from the screen.
- **Why it is dangerous.** Interrupted syncs are the normal case for the client (a dropped
  connection between push and pull, or between two pages): the user sees their change vanish and
  may enter it again, which creates a real duplicate. Found while making the protocol's
  acknowledgement exact; category 8 belongs to the offline-client change, but the fix is the
  acknowledgement itself, so it is made here.
- **Reproduce.** `acknowledgement.spec.ts`.
- **Fix.** An applied (or duplicate) result carries the change-log version of the mutation's last
  change. The client keeps the mutation in its queue, applied optimistically but not sent again,
  until its cursor reaches that version, and then drops it, so it is never shown twice either. A
  mutation without a version (it changed nothing) or with a version the cursor already passed is
  dropped at once. The last mutation id a pull reports removes mutations whose push answer was lost
  only on the last page (`hasMore` false): that page comes from the same snapshot as the id, and the
  pages before it held every change up to it.
- **Alternatives.** Using only the pull's last mutation id on the last page (the plan's first idea):
  a client that never reaches the end of the log under constant writes would never shorten its
  queue. Keeping the server's rows of a mutation in the push answer: the answer would grow with the
  mutation and duplicate what the pull delivers.
- **Commits.** `ec9fe40` (test), `9ad66be` (fix).

### F-31: deleting a ticket leaves its parts behind (category 9)

- **What.** `ticket.delete` deleted the ticket row only. Its parts stayed live on the server and on
  every client, and an adjustment of such a part, made by someone who had not seen the deletion
  yet, was still applied.
- **Why it is dangerous.** Concurrent edits do not merge into a consistent result: a delete and a
  part edit leave a part that belongs to nothing, kept forever in every client's state (and in any
  snapshot of it), and edited as if the ticket existed.
- **Reproduce.** `delete-ticket.spec.ts`.
- **Fix.** A mutator can declare the ticket whose parts it needs (`partsOf`); the server loads and
  locks them after the ticket, in id order, through a new partial expression index
  (`entities_part_ticket_idx`, built `CONCURRENTLY`; the test checks the planner can use it).
  `ticket.delete` deletes the parts with the ticket in the same mutation, each published as a `del`;
  a later adjustment of such a part is rejected with `NOT_FOUND`. A migration deletes the orphans an
  existing database already has and publishes their deletion through the log head, so clients drop
  them too. The client and the reference server of the simulation find a ticket's parts in their
  state. Parts are found by comparing the ticket id as text, so ids are accepted only in lower case
  (the form Postgres prints and `crypto.randomUUID()` makes); the same migration first stores the
  ids inside existing tickets and parts (`id`, `siteId`, `ticketId`) in lower case and publishes
  that, since the original server kept them as the client sent them.
- **Alternatives.** A foreign key with `ON DELETE CASCADE`: rows are never deleted (tombstones keep
  ids taken), and a cascade would not write the change log. Hiding parts of deleted tickets in the
  UI only: the data stays and keeps diverging from what the user expects.
- **Commits.** `6bde1c5` (test), `5042988` (fix).

### F-32: after a reload, a new mutation reuses an id the server already handled (category 8)

- **What.** The client stored its last applied mutation id only after a completed pull. When a push
  was applied but the pull after it failed (the network went down) and the page was reloaded, the
  client started numbering again after the stale stored id. The server answered the next mutation
  as a duplicate of the old one with that id, and the client dropped it from its queue.
- **Why it is dangerous.** The user's change is shown as synced, but the server never applies it,
  and nobody is told. It needs only a lost connection between a push and a pull, and a reload.
- **Reproduce.** `packages/sync-core/test/reload.spec.ts`.
- **Fix.** The client stores its state, the last applied id included, right after every push
  answer, not only after a pull. Ids after a reload continue after the last id the server handled.
- **Alternatives.** Storing the next id by itself: the same effect, but a second storage format
  next to the state; the queue that survives a reload (F-10) needs this state stored anyway. Random
  ids: the server could no longer tell a gap from a duplicate (see F-09).
- **Commits.** `479a024` (test), `5a998ac` (fix).

### F-33: a client id is not bound to its user (category 4)

The fix belongs to the access-control change; this change adds the known-defect test.

- **What.** The server takes any client id with any token. The `clients` row records the user who
  pushed first, but nothing checks it. Another user who knows a client id can push mutations under
  it; the owner's next mutation with the same id is then answered `duplicate` and dropped by the
  owner's client. Pull also returns the last mutation id of any client id.
- **Why it is dangerous.** A user can make another user's changes disappear without anyone being
  told. Client ids are random UUIDs, so this needs one to leak (for example from a log of pull URLs).
- **Reproduce.** `client-ownership.spec.ts`, "does not let another user's push take the next
  mutation id of the owner's client" (known defect, owner `access-control`).
- **What this change does.** Copies of a handled mutation are answered with their stored outcome
  (rejection details include stored field values) only for the client's owner; anyone else gets a
  bare `duplicate` (`client-ownership.spec.ts`, "never tells another user the outcome of the owner's
  mutations").
- **Planned fix.** Answer 403 for a client id that belongs to another user, in push and pull. The
  web app then needs one client id per user in a browser (it shares one for every user today).

### F-34: the change-log GC drops changes without telling anyone (category 5)

- **What.** The GC deleted every change-log entry older than the retention, with nothing to mark
  where the log now started. A pull with a cursor before the deleted entries answered 200 with the
  changes that were left, as if nothing were missing. A new client pulled from 0 and got only the
  entities whose history was still in the log. And `created_at` is the mutation's clock reading,
  taken before its commit (or, in the original code, the start of its transaction), so it does not
  grow with the version: deleting by age could remove a newer version and keep an older one.
- **Why it is dangerous.** A client that was offline longer than the retention, which is exactly
  the field technician's case, silently misses changes and never converges; a client installed after
  the first GC run never sees older tickets; a hole in the log loses a change even for a client that
  is up to date. Nobody is told.
- **Reproduce.** `log-compaction.spec.ts`: "brings a client that was offline longer than the
  retention up to date, queue included" and "gives a client that starts after the GC every live
  entity of its sites" (production `SyncClient` over HTTP, the GC run at a later virtual time), and
  "removes only a prefix of the log, even when a later version carries an earlier timestamp" (the
  test holds a row so that the mutation that read the earlier time commits last). In the simulation,
  the reference server's `compact-without-floor` defect shows up as `divergence`.
- **Fix.** Decision record [3.3.6](#change-log-lifecycle-336): the GC removes prefixes by version and
  raises `log_floor` in the same transaction; pulls below the floor get 410 `RESET_REQUIRED`;
  `GET /sync/snapshot` and the client's reload; tombstones and results expire with the log. The
  migration starts the floor below the oldest kept entry, so clients of a database the original GC
  already pruned are reset instead of missing changes.
- **Alternatives.** Compacting to the latest change per entity, or partitioning the log (see the
  decision record); keeping the original GC and making clients reload on a timer, which still loses
  changes between two reloads and reloads everyone needlessly.
- **Commits.** `54c3486` (test), `f17f51d` (fix).

### F-35: notification streams outlive their connection, and get no heartbeat (category 6)

- **What.** `StreamService` added every stream's response to a set and never removed it; nothing was
  written to an idle stream.
- **Why it is dangerous.** Every reload of a page left a subscriber behind for the life of the
  process: memory grows, and every notification writes to dead sockets. Without traffic a proxy
  drops an idle stream, and neither end notices a dead connection.
- **Reproduce.** `stream.spec.ts` (integration, over real HTTP: a client goes away and the count
  stays at 1; a hundred connections and closes; no byte on an idle stream).
- **Fix.** The stream is a `@Sse()` Observable: Nest unsubscribes when the connection closes, and the
  teardown removes the subscriber. The handler is synchronous, since Nest 10 listens for the close
  only once the handler has returned its Observable. An idle stream gets a `heartbeat` event every
  `STREAM_HEARTBEAT_MS` (Nest 10 cannot write SSE comments); pokes are merged within 250 ms; a client
  whose writes stay backed up for a whole interval is dropped.
- **Alternatives.** Keeping `res.write` and removing the subscriber on `res.on('close')`: works, but
  bypasses the framework's SSE support and its backpressure handling.
- **Commits.** `0da3a2d` (test), `4fdea61` (fix).

### F-36: open notification streams keep the server from shutting down (category 6)

- **What.** `app.close()` closes the HTTP server, which waits for every open connection, and an event
  stream never ends.
- **Why it is dangerous.** A deploy or restart hangs until the orchestrator kills the process, which
  cuts the requests in progress too.
- **Reproduce.** `stream.spec.ts`, "lets the application close while a stream is open".
- **Fix.** `StreamService.onModuleDestroy` ends every stream and refuses new ones; the HTTP server
  then closes normally, and requests in progress finish.
- **Alternatives.** `forceCloseConnections: true` (a standard Nest option): destroys every socket,
  also those of pushes in the middle of their answer.
- **Commits.** `cf610a7` (test), `d1f61da` (fix).

### F-37: the web app never closes its client and stream; a disposed client keeps working (category 6)

- **What.** The provider started a `SyncClient` and an `EventSource` for every token and never
  stopped them; `dispose()` did not abort the request in flight, and an answer that arrived after it
  was still stored.
- **Why it is dangerous.** After a change of token the old client keeps retrying and writes the old
  user's state into the shared storage; connections and timers leak.
- **Reproduce.** `dispose.spec.ts` (every request in flight is aborted; nothing is written after
  `dispose()`).
- **Fix.** Every request carries an abort signal tied to the client, and a request that ends after
  `dispose()` rejects instead of returning its answer (`4e8aaac`). The provider's effect disposes the
  client and closes its storage in its cleanup, also when the cleanup comes before the asynchronous
  open finished (`e84f17b`); development renders use React strict mode, which runs effects twice and
  shows a missing cleanup at once.
- **Commits.** `26d01b8` (test), `4e8aaac`, `e84f17b` (fix).

### F-38: a write the browser storage refuses is ignored (category 8)

- **What.** `LocalStorageSyncStorage.save` caught every error (a full quota) and the client went on
  as if the state were stored.
- **Why it is dangerous.** The user is shown "synced" while nothing survives a reload.
- **Reproduce.** `storage-errors.spec.ts`.
- **Fix.** A refused write rejects; the client reports `STORAGE` with the status `error`, a mutation
  it cannot store is not shown and its `mutate` rejects, and IndexedDB writes abort their whole
  transaction on any failure (also one thrown synchronously, which IndexedDB would otherwise commit
  around).
- **Commits.** `b7bb646` (test), `4aa2581`, `373c2a8` (fix).

### F-39: a notification that arrives while a sync is running is lost (category 1)

- **What.** `sync()` returned the sync already running. A poke that arrived after that sync's pull
  had read its page was dropped, and the client did not see the change until something else made it
  sync.
- **Why it is dangerous.** Delivery is incomplete for an indefinite time: the stream announced the
  change, the client discarded the announcement. Category 1 belongs to the protocol change, which was
  done; it was found here, with the stream.
- **Reproduce.** `pokes.spec.ts`.
- **Fix.** A sync asked for while one runs makes one more run after it (unless the running one
  failed; the retry timer runs the next) and resolves when that one ends.
- **Commits.** `5643cea` (test), `2e2ebe2` (fix).

### F-40: the next user of the browser sees the previous user's data (category 4)

- **What.** Every user of the browser shared one stored state (`fs_state`) and one client id
  (`fs_client_id`). There was no way to sign out; a user who signed in after another (a new token)
  saw the other's rows, of sites they have no access to, and pushed under the other's client id.
- **Why it is dangerous.** A read path that bypasses the server's access checks: the local cache.
  Category 4 belongs to the access-control change, still to come; the offline client owns local data,
  so the fix is here.
- **Reproduce.** e2e `user-switch.spec.ts`.
- **Fix.** Each user's state is in a database of its own, named after a SHA-256 of the token
  (`databaseNameFor`): it works offline from the first sign-in and does not contain the token. A
  sign-out button (with a confirmation when changes are not synced) removes the token and deletes
  every FieldSync database; a start with nobody signed in deletes any left behind; other tabs close
  on the deletion and show the sign-in form.
- **Alternatives.** A namespace by user id from `/me`: the first sign-in would need the network.
  Keeping a signed-out user's database: their data stays in the browser.
- **Commits.** `aae9a1a` (test), `4eddf32` (fix).

## Changes to starter tests

| Starter test | Change | Reason |
|---|---|---|
| `packages/sync-core/test/mutators.spec.ts` | Rejection tests require the exact code and unchanged state; "creates a ticket" checks that one row is written | F-02 |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…" | Checks the row content, not only the count | F-03 |
| `packages/sync-core/test/client.spec.ts` "numbers local mutations sequentially" | Checks the ids the client pushes | F-03 |
| `packages/sync-core/test/client.spec.ts` two `it.todo` | Real tests, tracked as known defects F-10, F-11 | F-06 |
| `packages/sync-core/test/mutators.spec.ts` "creates a ticket in the open status" | Passes an `id`; the fake transaction implements `insert` and `now` | Protocol change of F-19: `ticket.create` requires a client-chosen id and writes through `MutatorTx.insert`; timestamps come from `MutatorTx.now` (F-20) |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…", "numbers local mutations sequentially" | Every `ticket.create` passes an `id` | Protocol change of F-19 |
| `packages/sync-core/test/mutators.spec.ts` "creates a ticket in the open status" | Reads the created row with optional chaining (`created?.status`) | `sync-core` compiles with `noUncheckedIndexedAccess`: an array element may be `undefined`, so the type checker rejects the unguarded access |
| `packages/sync-core/test/client.spec.ts` `OfflineTransport` | Implements `snapshot` (it fails like the other requests) | Protocol change of F-34: a `Transport` also reads snapshots, and a client without a stored state starts with one |
| `packages/sync-core/test/client.spec.ts` (all) | Clients are disposed in `afterEach`, not at the end of the test body: a failing assertion skipped `dispose()`, the client's retry timer stayed alive and Jest never exited | A failing test must fail, not hang |
| `packages/sync-core/test/client.spec.ts` (all that call `mutate`) | `await client.mutate(...)`; the tests that read the view right after it are `async`; the unsendable-arguments test expects a rejection instead of a throw | The queue is written to IndexedDB before a mutation is shown, so `mutate` is asynchronous (F-10) |
| `packages/sync-core/test/client.spec.ts` fake transports | Pull answers and snapshot pages carry `head` | Protocol change of the offline-client work: the head bounds every sync under constant writes |
| `packages/sync-core/test/client.spec.ts` "retries and stamps optimistic rows…" | The client gets `random: () => 0.5` and the retry comes after 500 ms instead of 5 s | Retries use exponential backoff with jitter (task 3.3.3) instead of a fixed 5 s |
| `packages/sync-core/test/client.spec.ts` F-10, F-11, F-13 | Known defects become regular tests; F-10 waits for `ready`, F-13 uses the client's clock and checks the `TIMEOUT` error | Fixed by the offline-client change |
| `e2e/ticket-sharing.spec.ts` | Expects `synced · 0 pending` instead of `idle · 0 pending` | The status line shows the indicator of task 3.3.3 |
| `apps/server/test/access.spec.ts` | Tests renamed to what they check; the fake answers per query; admin and missing-`siteId` cases added | F-04 |
| `apps/server/test/pull.spec.ts` | Removed; replaced by `test/integration/pull-access.spec.ts` | F-01 |
| `apps/server/test/sync.integration.spec.ts` | Removed; replaced by `test/integration/sync.characterization.spec.ts` | F-05 |
| Jest configuration | Server tests resolve the workspace packages from source; integration tests are a separate project with global setup | Tests could pass against a stale `sync-core` build; integration tests need a database per file |

All files, the starter's included, were formatted with Prettier in a separate formatting-only
commit (`88d20f0`), listed in `.git-blame-ignore-revs` so that `git blame` skips it.

Evidence, from `scripts/audit-starter-tests.sh` (each starter test runs against code that breaks
the behaviour its name claims):

| Finding | Sabotage | Starter test, sabotaged | Replacement, sabotaged | Replacement, intact | Verdict |
|---|---|---|---|---|---|
| F-01 | pull ignores the site filter | PASS | FAIL | PASS | vacuous starter test |
| F-02 | invalid status transition is allowed | PASS | FAIL | PASS | vacuous starter test |
| F-03 | all local mutations get id 1 | PASS | FAIL | PASS | vacuous starter test |
| F-04 | admins get no implicit access | PASS | FAIL | PASS | vacuous starter test |
| F-05 | push reports applied mutations as duplicates | PASS | FAIL | PASS | vacuous starter test |

F-06: the starter client.spec reports 2 todo tests (never executed); the replacement runs 2 known-defect tests that assert the behaviour.

## Simulation

A seeded, deterministic simulation of several clients working through an unreliable network
against the real server on a real Postgres, written as fast-check model-based tests. The engine is
`packages/sim` (no server code); the binding to the server, the CI corpus and the `npm run sim`
command are in `apps/server/test/simulation`. Why it is built this way:
[decision record](#deterministic-simulation-332).

A **run** is one scenario that fast-check generates; a search tries a number of runs from one
**seed**, and fast-check names each run by its **path** (`0`, `1`, … for the runs of a search, longer
paths such as `12:3:0` for shrunk scenarios).

```mermaid
flowchart LR
  seed[seed] --> gen["fast-check: fc.commands"]
  gen --> open[open: every client syncs]
  open --> faults["fault phase: commands via fc.asyncModelRun"]
  faults --> heal["heal: deliver, answer, advance timers"]
  heal --> check{"liveness and convergence"}
  check -- violation --> shrink["shrink (seed + path, time limit)"]
  shrink --> report["report: seed, path, replayPath, steps, trace"]
  check -- ok --> next[next run]
```

### What a run does

Every run builds the profile's sites, users and tokens (derived from positions, not drawn at
random) on an emptied database. Then:

1. **Open.** Every client syncs once, as the web app does on start.
2. **Fault phase** (up to 180 commands, fast-check `fc.commands` weighted per profile). Each
   command is one step:

   | Step | What happens |
   |---|---|
   | `act` | A user acts on what their client shows: creates or edits a ticket, changes its status, deletes it, adds a part, adjusts a quantity. Text is mostly plain, sometimes non-ASCII or emoji, sometimes exactly at a length limit (a description longer than its limit has an emoji across the cut); in the rejection profiles sometimes empty, too long, with NUL or with an unpaired surrogate. Most actions target a few shared rows, as technicians of one site work on the same jobs |
   | `sync` | A client syncs, as when the user asks for it |
   | `deliver` | The oldest request of a client reaches the network, with a request fault (below) |
   | `respond` | The oldest answer the server produced for a client goes back, with a response fault |
   | `redeliver` | A stale copy of an earlier request reaches the server again |
   | `tick` | Virtual time advances (up to 8 s), firing due timers such as the client's 5 s retry |
   | `link` | A client's link goes down, comes back, or starts losing every answer |
   | `compact` | The server runs its change-log GC at the current virtual time (the simulation runs with a retention of one hour) |
   | `away` | A client's link goes down and two hours of virtual time pass at once (fake-timers `setSystemTime`: pending timers move with the time, so no thousand retries fire); after a `compact`, its cursor is behind the floor and the client is reset when it comes back |
| `reload` | The page of a device reloads: its leading tab is disposed at once, whatever it is doing (a request in flight, a write about to start), and a new tab opens on the device's storage |
| `tab` | A second tab of the device opens on the same storage, or, with two open, the leading one closes and the other takes over (tabs are coordinated like browser tabs, `TabGroup`) |
| `poke` | The notification stream of a device delivers a poke the server sent for another device's change |
| `drop-stream` | The notification stream of a device breaks; the client reopens it with its backoff (a link going down breaks it too) |

3. **Heal.** Every link comes back and faults stop. Requests and answers are delivered and time
   advances to the next timer until nothing is in transit and no client has pending mutations;
   then every client syncs once more. The system gets 400 steps for this.

**Faults.**

| Kind | Fault | Effect on the server | Effect on the client |
|---|---|---|---|
| Request | `drop-request` | never sees it | `fetch` fails |
| Request | `duplicate` | handles it twice in a row | gets the second answer |
| Request | `hold-copy` | handles it now and once more later (`redeliver`) | gets the first answer |
| Request | `hang` | handles it | never gets an answer; the connection never closes, until the client's request timeout |
| Request | `cut-request` | gets half of the body (answers 400, applies nothing); a request without a body never reaches it | gets no answer |
| Response | `drop-response` | already handled it | `fetch` fails |
| Response | `bad-gateway` | already handled it | gets a 502 from a "proxy" |
| Response | `truncate` | already handled it | gets half of the body |
| Link | `down` | sees nothing from the client | every request fails |
| Link | `responses-lost` | handles every request | never gets an answer (one-way partition) |
| Clock | skew | — | the client's clock is off by up to 90 s |

### Properties

- **Liveness.** After the network heals, every client's queue drains within the heal budget. A
  client still busy at the end is a livelock (or the signature of the known defect that stuck it).
- **Convergence.** Then every client holds exactly the server's live rows of the sites its user can
  access, with the same contents (key order ignored). When some clients never drained, the others
  are still checked: they sync once more with only their own requests delivered, so the server's
  rows do not change, and are compared like after a full heal. A client stuck on a tolerated known
  defect therefore never hides a lost row elsewhere. Rows of sites the user cannot access are
  reported as `foreign-site-rows`, and anything else (a missing, different or stale row of the
  user's own sites) separately as `divergence`, so a tolerated leak never hides a wrong row either. The server's rows are read straight from the
  `entities` table and the accessible sites come from the run's fixtures: neither goes through the
  server's pull path or access checks, so the system is never its own oracle.
- **No lost edits** (category 9). Every title and description of a live ticket holds the value of
  the last applied mutation that wrote that field: an edit of one field never undoes another
  client's edit of the other. The expected value comes from the push requests and answers the
  network carried, not from the server: the arguments of each mutation answered `applied`, in the
  order of the answers (the server handles one request at a time), with the documented rules of what
  `ticket.create` and `ticket.update` write. A ticket written by a mutation whose first answer was
  lost (it shows up only as `duplicate`) has no known place in that order and is not checked.
  Convergence alone cannot see such a loss: the client and the server run the same mutators, so
  both lose the edit the same way.
- **No lost mutations** (category 5 and the reset). Every mutation a client queued was handled by
  the server: its last mutation id, read straight from the `clients` table, equals the number of
  mutations the client queued, and the queue is empty. A reset that dropped a queued mutation, or a
  client that dropped one it was never answered for, shows up as `lost-mutation`.
- **Determinism.** A seed run twice gives the same traces, byte for byte (compared by SHA-256), and
  replaying one run from its seed and path gives the same trace again. The trace holds only semantic facts:
  steps, requests and answers (status, body digest, the class and code of server-side exceptions),
  final client states; no host time or host-specific text.

Each violation has a **signature**:

| Signature | Meaning | Known defect |
|---|---|---|
| `rejected-mutation-500` | a queue never drained because the server answered 500 to a mutation it rejected | — (F-23, fixed) |
| `unexpected-rejection` | the server rejected a mutation with a code none of the profile's actions can cause | — |
| `lost-edit` | a ticket field does not hold the last applied write of that field | — |
| `foreign-site-rows` | a client holds rows of a site its user cannot access | F-07 (access-control change) |
| `stuck-request` | a client waits forever on a request that never completes | — (F-13, fixed: requests time out) |
| `livelock` | a queue never drained for another reason | — |
| `divergence` | a client's rows differ from the server's within its sites | — |
| `client-error` | the client code threw (for example while computing its view) | — |
| `lost-mutation` | a client's queue is empty but the server never handled some of its mutations | — |

### Profiles

| Profile | Sites, users, clients | Actions | Faults | Tolerated signatures |
|---|---|---|---|---|
| `baseline` | 1 site, 3 technicians, 4 devices (one technician on two), each with one or two tabs | create, edit, add part, increase quantity: nothing the server can reject | all but `hang` | none: must converge on every seed |
| `rejections` | as `baseline` | all, including status races, deletes against edits, adjustments near zero, invalid text | all but `hang` | none; every rejection must carry a code the actions can cause |
| `multi-site` | 2 sites; a technician of each, one of both, an admin; 4 clients | as `baseline` | all but `hang` | `foreign-site-rows` |
| `full` | as `multi-site` | as `rejections` | all, `hang` included | `foreign-site-rows` |

A profile may produce only its tolerated signatures; anything else fails. Each tolerated signature
is a known-defect test in the corpus, so the change that fixes the defect sees "appears fixed - flip
it" and removes the signature from the profile. Each profile also has minimums for the average per
seed of its run statistics (every fault kind occurs, timers fire, clients write rows another client
wrote last, the rejection profiles see rejections), so a profile cannot quietly stop exercising what
it is for. Lowering a minimum needs a reason here.

The offline-client change added `reload` (weight 2), `tab` (2), `poke` (5) and `drop-stream` (2) to
every profile, the request fault `cut-request`, and minimums of 0.3 reloads, 0.3 tab changes, 0.6
pokes, 0.15 dropped streams and 0.4 cut requests per seed. It lowered the minimum of writes to a row
another client wrote last from 0.8 to 0.4 (0.6 to 0.2 with two sites): every stream that opens and
every poke queues a pull, so more exchanges wait on the network and the views users act on are older;
raising the weight of `act` did not bring it back.

The log lifecycle change added `compact` (weight 4) and `away` (weight 3) to every profile, with
minimums of 0.8 compactions, 0.5 periods away and 0.1 resets (410 answers) per seed, and lowered the
minimum of writes to a row another client wrote last from 1.5 to 0.8 (1 to 0.6 with two sites): every
client now starts from a snapshot and then the log, one exchange more before it sees the other
clients' rows, and the two new steps take a share of the commands. Over 60 runs per profile from
seed 1 the real server averaged 0.98 such writes (`baseline`), 1.3 compactions, 1.0 periods away and
0.45 resets per run.

### Reproducing a failure

`npm run sim` searches every profile (or one, `--profile`) for `--runs` scenarios from `--seed`
(without `--seed`, one derived from the current time, which it prints). It stops a profile at its
first violation that the profile does not tolerate, shrinks it for up to `--shrink-ms` (default
120 s; `0` reports the failure as found) and prints:

```text
Simulation failed: profile <name>, seed <seed>, path <path> (trace <hash>)
  - <signature> at <client>: missing=… unexpected=… different=…
Replay: npm run sim -- --profile <name> --seed <seed> --path <path> --replay-path '<hint>' --trace
Scenario (shrunk from <n> to <m> steps in <k> shrinks):
  0. act c1 edit-ticket
  1. deliver #0 fault=duplicate
  …
Last 60 trace lines:
  …
```

The `Replay` line runs exactly that scenario again and prints its full trace (`--trace`). As soon
as a profile is done, its summary follows: how many runs showed each signature, with their paths,
and the average run statistics; a later failure or Ctrl+C does not lose it. Progress goes to stderr
with the runs per second and the estimated time left. Profiles are independent, so a long search
can run one process per profile (`--profile`) in parallel; each uses its own database. Exit codes: 0 no unexpected violation, 1 unexpected violations, 2 invalid options,
130 interrupted (Ctrl+C finishes the current scenario and cleans up; a second Ctrl+C quits at once).
All options: `npm run sim -- --help`.

`npm run sim` creates a migrated throw-away database next to `DATABASE_URL` and drops it at the end,
also after the first Ctrl+C; a second Ctrl+C exits at once and leaves it behind
(named `fs_test_<start time>_sim_…`; the global setup of the integration tests drops such databases
once they are older than six hours).

**Common issues.**

- *`DATABASE_URL is not set`* (exit 2): start Postgres (`docker compose up -d postgres`) and pass
  `DATABASE_URL=postgres://fieldsync:fieldsync@localhost:5432/fieldsync`.
- *`--path needs the --seed it was found with`*: a path means nothing without its seed; copy the
  whole `Replay` line.
- *A replay passes although the search failed*: the run reports `failed once but passed on replay`
  and stops; that is a determinism defect in the code under test or the harness, and must be
  investigated, not retried.

### CI corpus and budget

The integration job runs `npm run test:sim` (`corpus.ts`): from seed 1, the first 40 runs of
`baseline` and the first 20 of each other profile (the runs fast-check generates first, so no
scenario is chosen for being convenient), the check that one seed gives the same traces twice on the
real server, the binding's own tests and the detection checks below. The first unexpected failure
of a profile is shrunk for up to 60 s. Budget: 60 s on the CI runner (about 25 s locally); the step
has a 5-minute timeout as a safety net only, since a timing assertion would be flaky on shared
runners. Changing a seed, a run count or the budget needs a reason here.

The `sim-cli` job checks the command itself on Linux, macOS and Windows without a database
(`scripts/sim-cli-smoke.sh`: help, version, option errors, exit codes).

### Checks of the harness itself

- The engine runs against an in-memory reference server in its own tests (`packages/sim/test`),
  with defects that can be switched on: a row that pull never returns, rejections answered with 500,
  other sites' rows in incremental pulls, a push that always fails, corrupted rows, INTERNAL
  rejections, an edit that empties the description it leaves out. Each must be
  reported with its signature, a search must stop at the first such run, and the correct server must
  converge on every run of every profile (in `full`, it may only get stuck on hung requests). The
  profile minimums are checked there as averages over 60 runs.
- Every network fault has a test of its own (`network.spec.ts`), and so do the virtual clock
  (`clock.spec.ts`) and the oracle (`oracle.spec.ts`). Shrinking is tested end to end: a failure
  shrinks to fewer steps that still fail, and its seed, path and `replayPath` replay it to the same
  trace.
- Against the real server, putting a determinism defect back into `ticket.create` must fail the
  simulation: an id made up by the mutator (F-19) fails a baseline run, and a wall-clock timestamp
  (F-20) makes one seed give two different traces, and a `ticket.update` that empties the
  description an edit leaves out, as the original one did (F-27), is reported as `lost-edit`
  (`detection.spec.ts`).

### Results

After the offline-client change, a local search of 1000 runs per profile from seed 20261128
(`npm run sim -- --profile <name> --seed 20261128 --runs 1000`, one process per profile, about
7 minutes) found no violation other than the access-control defect F-07: no divergence, lost edit,
lost mutation, unexpected rejection, and no request stuck any more, with reloads at any point, a
second tab, the notification stream and requests cut in the middle in every profile.

| Profile | Runs without violations | Known-defect runs | Reloads per run | Tab changes per run | Pokes per run | Dropped streams per run | Cut requests per run |
|---|---|---|---|---|---|---|---|
| `baseline` | 1000 / 1000 | — | 0.73 | 0.70 | 1.16 | 0.58 | 0.94 |
| `rejections` | 1000 / 1000 | — | 0.68 | 0.76 | 1.21 | 0.55 | 0.91 |
| `multi-site` | 102 / 1000 | `foreign-site-rows` (F-07): 898 | 0.73 | 0.70 | 1.16 | 0.58 | 0.94 |
| `full` | 124 / 1000 | `foreign-site-rows` (F-07): 876 | 0.68 | 0.76 | 1.21 | 0.55 | 0.89 |

The same search before the change (no reloads, tabs or stream in the simulation): `baseline` and
`rejections` 1000 / 1000, `multi-site` 119 without violations (F-07 in 881), `full` 105 (F-07 in 762,
`stuck-request` (F-13) in 370).

After the log lifecycle change, a local search of 1000 runs per profile from seed 20261127
(`npm run sim -- --profile <name> --seed 20261127 --runs 1000`, one process per profile, about
7 minutes) found no violation other than the known defects each profile tolerates: no divergence,
lost edit, lost mutation or unexpected rejection, with compaction and clients away longer than the
retention in every profile.

| Profile | Runs without violations | Known-defect runs | Resets (410) per run | Compactions per run | Time per run |
|---|---|---|---|---|---|
| `baseline` | 1000 / 1000 | — | 0.38 | 1.49 | 432 ms |
| `rejections` | 1000 / 1000 | — | 0.44 | 1.57 | 429 ms |
| `multi-site` | 126 / 1000 | `foreign-site-rows` (F-07): 874 | 0.38 | 1.49 | 433 ms |
| `full` | 137 / 1000 | `foreign-site-rows` (F-07): 729; `stuck-request` (F-13): 359 | 0.36 | 1.57 | 405 ms |

The same search before the change (no compaction in the simulation) found the same known defects;
the simulation could not see category 5 at all, since the GC never ran.

Earlier, after the protocol change, a local search of 1000 runs per profile from seed 20261126
(`npm run sim -- --profile all --seed 20261126 --runs 1000`, about 15 minutes in all, fast-check
4.11.0) found no violation other than the known defects each profile tolerates. No run shows a
divergence, a lost edit, an unexpected rejection or `rejected-mutation-500`:

| Profile | Runs without violations | Known-defect runs | First paths (replay with `--seed 20261126 --path N`) | Time per run |
|---|---|---|---|---|
| `baseline` | 1000 / 1000 | — | — | 253 ms |
| `rejections` | 1000 / 1000 | — | — | 226 ms |
| `multi-site` | 123 / 1000 | `foreign-site-rows` (F-07): 877 | 0, 1, 2 | 224 ms |
| `full` | 100 / 1000 | `foreign-site-rows` (F-07): 777; `stuck-request` (F-13): 415 | F-07: 0, 1, 2; F-13: 0, 1, 3 | 204 ms |

Per run on average: about 90 fault-phase steps, 4.5 dropped requests, 1.7 duplicates, 1.7 held
copies redelivered later, 2.9 dropped answers, 0.9 bad gateways, 0.9 truncated bodies, one link down
and half a one-way partition; 2.6 writes per run (`baseline`) to a row another client wrote last; in
the rejection profiles about 4 mutations per run rejected by the server, each with a code the
profile's actions can cause.

Before the protocol change, the same search from seed 1 found `rejected-mutation-500` (F-23) in 703
of 1000 `rejections` runs and 644 of 1000 `full` runs (first path 0; for example
`npm run sim -- --profile full --seed 1 --path 3 --trace` on the commit before `0abb406` shows the
hung request of F-13 together with F-23 and F-07).

### Limitations

- **No real concurrency.** Requests reach the server one at a time, so races between transactions
  (the change-log ordering of category 1, parallel duplicates of category 2) are out of the
  simulation's reach. They are tested concurrently on Postgres: `client-ids.spec.ts`,
  `commit-order.spec.ts`, `duplicates.spec.ts` and `lock-order.spec.ts`.
- **One server instance.** The stream is the simulated network's, not the server's SSE endpoint:
  opening it says `ready`, a push the server applied makes a poke wait for every other device with
  an open stream, and the `poke` step delivers it. The stream endpoint itself is tested over real
  HTTP (`stream.spec.ts`) and in the browser (e2e).
- **One storage per device in memory** (`MemoryStorage`): IndexedDB is tested on fake-indexeddb and
  in Chromium, not in the simulation.
- **Not yet simulated:** access changes and moving tickets (the access-control change), two server
  instances (the observability change). Each of these changes adds its events as new commands.
- Traces are compared within one environment; a different Node.js or Postgres version may change
  response bodies (for example error messages) and with them the trace digest, but not whether a
  run passes. A new fast-check version may generate different scenarios from the same seed, so the
  corpus and the documented paths below hold for the locked version.

## Load test

Not written yet: the load scenario (≥ 200 clients) is added with the observability work.

## Indexes

The indexes for the access queries are added with the access control change. The log lifecycle
added the indexes of its own queries, each chosen with `EXPLAIN (ANALYZE, BUFFERS)` before and
after, on a database of 1 000 000 log entries over 100 sites, 300 000 entities (10 % deleted) and
500 000 mutation results (local Postgres 16):

| Query | Without the index | With it | Index |
|---|---|---|---|
| Snapshot page in the middle of a site of 100 000 rows (`WHERE NOT deleted AND site_id = ANY(…) AND (site_id, entity, id) > (…) ORDER BY site_id, entity, id LIMIT 501`) | 19 ms, 50 101 rows read through `entities_site_idx` and sorted | 2.6 ms, index scan of 501 rows | `entities_snapshot_idx (site_id, entity, id) WHERE NOT deleted` |
| Tombstones of one GC batch (`WHERE deleted AND version > … AND version <= …`) | 36 ms (sequential scan of `entities` per batch) | 4 ms | `entities_tombstone_idx (version) WHERE deleted`; dropped by the offline-client change, which keeps tombstones, so no query uses it |
| Results of the applied mutations of one batch | 25 ms (sequential scan) | 2 ms | `mutation_results_applied_version_idx (version) WHERE status = 'applied'` |
| Next batch of the log (`WHERE version > floor ORDER BY version LIMIT 5000`) | — | 7 ms, primary key | `change_log_pkey` |
| Expired results without a version, 5000 at a time | 72 ms with `IN (subquery)` (hash join over the whole table) | 8.7 ms with `ctid = ANY(ARRAY(subquery))` (TID scan); a partial index on `created_at` made it slower (17 ms) | none |

On sites of about 2000 rows the planner keeps using `entities_site_idx` with an incremental sort
(1.3 ms per page); the snapshot index matters for large sites, where the sort would read the whole
site up to the page and make a snapshot quadratic. `change_log_created_idx` was dropped: since the GC
removes the log by version, no query filters it by `created_at`, and every write paid for it. The
plans were checked with `EXPLAIN (ANALYZE, BUFFERS)` on that database; the migration builds and
drops the indexes concurrently.

## Observability

Not written yet: structured logging, `/metrics` and readiness are added with the observability
work.

## Limitations & what we'd do differently

- **Runtime and framework versions are kept as they are** (Node 20, NestJS 10, Next.js 14) by
  decision; only the lockfile is new. Node 20 left long-term support in April 2026. `npm audit`
  reports 20 known vulnerabilities (1 critical in `next`; high in `body-parser` and `multer`
  through `@nestjs/platform-express`, and in `eslint-config-next`; moderate ones elsewhere). The
  API has no multipart endpoints, so `multer` is never used; the JSON body limit is set explicitly
  (`JSON_BODY_LIMIT_BYTES`, F-28). The upgrade path is Node 22 or 24 LTS, NestJS 11 and a current Next.js
  release, each with its own change and the full test suite as the safety net.
- `typeorm` is flagged (moderate) through its `glob` dependency's command-line tool, which is never
  run: migrations are listed explicitly, not globbed.
- Docker base images use the `node:20.19-alpine` tag, not a digest. CI reports the images' known
  vulnerabilities (Trivy, HIGH and CRITICAL) in the job summary without failing the build; most of
  them come from the kept runtime versions and from the npm copy in the Node base image.
- The web app must be served from a secure context (HTTPS, or `localhost`): like the original
  code, it creates client, ticket and part ids with `crypto.randomUUID`, which browsers expose only
  there.
- E2e runs on one Postgres share the database name `fieldsync_e2e` unless `E2E_DATABASE` is set;
  two simultaneous runs against the same server would collide.
- Four defects are reproduced but not fixed yet (F-07, F-08, F-33, all of the access-control
  change); each is a known-defect test with an owner and is listed by every test run.
- Writes are serialized on the change log's head for the last statement of each mutation, which
  bounds write throughput per database (see [3.3.1](#protocol-correctness-331)).
- Offline client (see [3.3.3](#offline-first-client-333) and [3.3.7](#schema-evolution-337)): it
  needs IndexedDB, Web Locks and BroadcastChannel (secure contexts); pokes come only from the server
  instance that applied a change; signing out with unsynced changes discards them after a
  confirmation; a client released before protocol versioning cannot understand "update required".
  Every deletion keeps a tombstone for good.
- Log lifecycle (see [3.3.6](#change-log-lifecycle-336)): a snapshot must finish within the
  retention; a
  rejection's reason is lost after `MUTATION_RESULT_RETENTION_SECONDS`; push p95 rises by up to
  about 5 ms while the GC collects a large backlog; partitioning the log is the documented way once
  it outgrows the database server's memory; a client released before this change cannot handle
  `RESET_REQUIRED`; during a rolling update the old instances' GC must be stopped; holes the original
  GC left inside the kept log cannot be told apart from versions rolled back under the old sequence,
  so the migration cannot reset the clients they affect.
- A session waiting for a lock does not notice that its client process died; it ends when it gets
  the lock or its `lock_timeout` expires, so a crash leaves no trace either way.
- There is no revert command. TypeORM's `undoLastMigration` ignores a migration's
  `transaction = false` and reverts in a transaction, which `DROP INDEX CONCURRENTLY` cannot run in;
  reverting by hand (as the migration tests do) needs `{ transaction: 'none' }`.
- The OpenAPI document is 3.0 (`@nestjs/swagger` 8, the last version for NestJS 10).
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on for `sync-core` only, the
  shared protocol code; the server and the web app follow when they are next reworked.
