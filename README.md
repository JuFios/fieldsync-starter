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

The images are multi-stage builds installed with `npm ci`; their runtime stages hold the server's
production dependencies or the web app's Next.js standalone output, run as `node` and have
healthchecks. `.dockerignore` keeps local `.env` files out of them. The original images ran as root
and copied whole package directories, local `.env` files included, and the original compose file
had no migration step; `scripts/docker-smoke.sh` plants canary `.env` files and checks all of this.

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

CI installs from the committed lockfile with `npm ci` (the original repository had none and ran
`npm install`, so each run could resolve other versions), type-checks every package (the original
`typecheck` skipped the web app), runs ESLint with type information and fails on warnings, and
checks the formatting. Static checks with the unit tests and the build, the Postgres 16 suites
(`REQUIRE_DB=1`), the simulation command on three operating systems, the e2e tests and the Docker
check are separate jobs.

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

The original server read each setting as `Number(process.env.X ?? default)` without a check:
`GC_INTERVAL_MS=1h` became `NaN`, which `setInterval` treats as 1 ms, so the change-log `DELETE`
ran about once a millisecond (`config.spec.ts`).

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
startup. There was no record of the schema version and no way to evolve it. When `ROLLBACK` failed
too, the transaction helper reported that failure instead of the error that had caused it; and
neither the pool nor its clients had an `error` listener, so a connection that Postgres dropped (a
restart, a failover, an idle-session timeout) ended the Node process. The task allows an ORM if the
choice is justified.

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
  error reaches the caller (TypeORM's `rollbackTransaction` throws), and always releases
  (`transactions.spec.ts`). An `AggregateError` of both would change the error type every caller
  sees.
- The pool and every query runner listen for connection errors: the request that used a dropped
  connection fails with 500, the server keeps serving and the transaction leaves no partial write
  (`connection-loss.spec.ts`).
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
values through `ConfigService<EnvironmentVariables, true>` with `infer: true`. Joi as
`validationSchema`, the other approach that documentation shows, would be one more dependency next
to `class-validator`, which the request DTOs use anyway.

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

**The same arguments in both environments.** Convergence also needs the client and the server to
run a mutation on the same input. The shared mutators check their id arguments as UUIDs and reject
text Postgres cannot store (NUL, or a string that is not well-formed UTF-16:
`String.prototype.isWellFormed`, with its `core-js` polyfill in the web app, since Next.js 14
supports browsers that lack it) with `BAD_ARGS`, and a long description is cut without splitting a
surrogate pair. Before, only the server checked ids, and the client applied what the server could
only fail on (`arguments.spec.ts`, `unstorable-arguments.spec.ts`). `mutate` queues and applies a
JSON round trip of the arguments, which is what the server receives, and throws a `TypeError`
without queueing anything when they cannot be serialised: it used to keep the caller's object, so a
later change of it split the view from what was sent, and a `BigInt` made every push throw
(`client.spec.ts`). Not chosen: `toWellFormed`, which changes what the user typed without saying
so, and `structuredClone`, which keeps `Date`, `Map` and `BigInt` values that JSON changes or
refuses.

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

**Requests.** `PushRequestDto` and `PullQueryDto` are checked by the global `ValidationPipe`:
decimal integers only (so `1e3` and `""` are refused), cursors and mutation ids up to 2^53 − 1 (the
integers JSON numbers carry exactly), pages of 1 to 500 changes and UUID client ids; anything else
is a 400. The original read `cursor` and `limit` with `Number(x) || 0`, so `cursor=abc` silently
resynced from the start of the log, while `cursor=1.5` or a client id with a NUL character ended in
a 500 (`request-validation.spec.ts`). `ParseIntPipe` checks no range, and
`enableImplicitConversion` turns `""` into 0. Mutator arguments are left to the shared mutators, so
one bad argument rejects its own mutation, not the batch. A mutator is looked up among the table's
own entries (`Object.hasOwn`): names such as `toString` or `__proto__` used to pass the lookup and
end in a 500, and are now rejected as `UNKNOWN_MUTATOR` (`mutator-lookup.spec.ts`).

**Batch size.** The protocol fixes the largest push body (`MAX_PUSH_BODY_BYTES`, 1 MiB of UTF-8
JSON). The client splits its queue into bodies of at most 100 mutations and that many bytes, and
`mutate` refuses a single mutation that could never fit; the server's JSON limit
(`JSON_BODY_LIMIT_BYTES`) is set with `app.useBodyParser` and is never below the protocol's.
Before, the client counted only mutations and the server kept Express's 100 KB: ten tickets with
long descriptions were refused with 413 on every retry, and everything queued behind them waited
(`body-limit.spec.ts`, `push-batches.spec.ts`). Raising only the server's limit would not do: any
fixed limit can be exceeded by a long enough batch.

**Pull.** One `REPEATABLE READ READ ONLY` transaction reads the head, then at most `limit` changes
with versions up to the head, and the client's last mutation id, all from one snapshot. Pages are cut
by version, independently of the site filter; without more changes the cursor moves to the head.
The client drops pending mutations that the server has applied only once it has caught up
(`hasMore` false), and keeps an applied mutation in its view until it has pulled the change it made
(the version in the push answer), so nothing flickers away in between (F-30). The pull's last
mutation id alone could not do this: a client that never reaches the end of a log under constant
writes would never shorten its queue.

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
ticket's parts live, and a part adjustment made before its author saw the deletion still applied;
`part.add` under a taken id returned early, so the push reported a part as added that the next pull
removed. Quantity adjustments and status changes were already relative to the
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

**Parts and their ids.** A mutator declares the ticket whose parts it needs (`partsOf`); the server
loads and locks them through a partial expression index (`entities_part_ticket_idx`, built
`CONCURRENTLY`). Parts are matched by their ticket id as text, so ids are accepted only in lower
case, the form Postgres prints and `crypto.randomUUID()` makes. The migration stores the ids inside
existing tickets and parts in lower case, deletes the parts already orphaned and publishes both
through the change log, so clients follow. A foreign key with `ON DELETE CASCADE` would not help:
rows are never deleted (tombstones keep ids taken), and a cascade would not write the change log.
`part.add` writes through `MutatorTx.insert`: an id taken by any part, a deleted one included, is
rejected with `ID_CONFLICT`; retries are deduplicated by mutation id, so no early return is needed.

**Evidence.** `mutators.spec.ts` (the whole transition table, patches, conflicts, the cascade, a
taken part id), `client-ids.spec.ts`, `determinism.spec.ts` (adjustments commute), `merge.spec.ts`
and `delete-ticket.spec.ts` on Postgres, and the simulation's "no lost edits" property.

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
ignored a refused write, had no request timeout, retried every 5 s, and its web app never closed it
(F-37). Every user of a browser shared that stored state and one client id. The task asks for a
queue that survives reloads, tabs that do not break each other's queue, reconnection with
exponential backoff and jitter, and a status that tells synced, pending, offline and rejected apart.

**Storage.** IndexedDB through `idb` (decision Д-6), one database per user (named after a SHA-256
of the token), four stores: `meta` (client id, cursor, last and next mutation ids, an update
refusal, a client id being retired), `base` (the server's rows), `pending` (the queue, keyed by a
generated position) and `rejections`. Every change of the state is one transaction that awaits only
its own requests (a transaction commits once it has no pending request: MDN, `idb` "Transaction
lifetime") and aborts on any failure; queue writes use `durability: 'strict'`, pull pages and
snapshots, which the server can send again, `relaxed`. A mutation gets its id in the transaction that
queues it and is shown only once stored: what the user sees survives a reload. `MemoryStorage`
implements the same interface for tests and the simulation.

A write the storage refuses (a full quota) rejects: the client reports `STORAGE` with the status
`error`, a mutation it cannot store is not shown and its `mutate` rejects, and a transaction is
aborted on any failure, one thrown synchronously too, which IndexedDB would otherwise commit around
(`storage-errors.spec.ts`). The original caught the error and showed "synced" while nothing would
survive a reload.

**Users of one browser.** With one database per user, a user who signs in after another neither sees
the other's rows, which may belong to sites they have no access to, nor pushes under the other's
client id. The name does not contain the token, and a first sign-in works offline (a user id from
`/me` would need the network). Signing out, confirmed when changes are not synced, removes the token
and deletes every FieldSync database; a start with nobody signed in deletes any left behind, and
other tabs close on the deletion and show the sign-in form (e2e `user-switch.spec.ts`). Keeping a
signed-out user's database would leave their data in the browser.

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
control it; `AbortSignal.timeout()` would run on real time) and on `dispose()`, and fails as
`TIMEOUT`. Without a limit one request that never answered stopped syncing until a reload, since a
running sync is not started twice (`client.spec.ts`, the simulation's `hang` fault). Retries use
exponential backoff with full jitter (a random delay below a ceiling that starts at 1 s and doubles
up to 60 s; AWS Architecture Blog, "Exponential Backoff And Jitter"), never sooner than a
`Retry-After`, reset after a success; the web app syncs at once on the browser's `online` event. The
notification stream is read over `fetch` with `eventsource-parser`, so it carries the bearer token
and the protocol version in headers like every other request (the browser's `EventSource` can send
neither): on `ready` and on every `poke` the client syncs, a stream silent for three heartbeat
intervals is reopened, every reopening waits a backoff delay. A sync asked for while one runs makes
one more run after it, unless that one failed (the retry timer runs the next), and resolves when it
ends; before, the poke of a change committed after the running sync's pull was dropped
(`pokes.spec.ts`). A pull stops at the head of its first page, and a snapshot is installed once its
tail reaches the highest head of its pages (each page says the head it was read at): under writes
faster than a page per request, neither waits for a page without more changes, which never comes.

**Shutdown.** The server ends every open stream (`onModuleDestroy`, F-35), then stops its HTTP
server with `stoppable` before Nest closes it and the database pool: no new connections, every
request in progress is answered, and each connection is closed once nothing on it waits for an answer
(`stream.spec.ts` holds a push back on its client row while the application closes, with and without
an open stream: it is answered 201 and applied once, and the application closes although its client
goes on using the connection; `http-shutdown.service.spec.ts`). `server.close()`, which Nest calls,
closes only the connections idle at that moment: one that was busy then and was kept alive was served
for as long as its client used it (the built server was still running 15 s after `SIGTERM`), and held
the process for the 5 s keep-alive timeout otherwise. Alternatives: Nest's `forceCloseConnections`
destroys connections with requests in progress; `http-terminator` does so after a grace period (1 s
by default) and brings four dependencies; setting `Connection: close` on the remaining responses is
code of our own. `stoppable` sends no such header (RFC 9112, 9.6, says a server SHOULD when it
intends to close), so a request a client puts into a connection being closed fails on its side and
is sent again (however many copies arrive, a push is applied once). It
is used without a grace period: a request that never ends (a body that never arrives) holds the
process until the process manager kills it (Docker: after 10 s by default).

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
change's): a client whose stream is on another instance gets none and has the change from its next
sync on (`two-instances.spec.ts`: two instances on one database, a live client on one, a push through
the other). Nothing is lost, but for an idle client with a healthy stream that next sync has no time
bound: it comes when one of its tabs queues a change, its stream reopens, the device comes back
online, the page reloads or another tab takes the lead. Signing out with unsynced changes discards
them after a confirmation.

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
for a reload, so the upgrade is never kept waiting by this app's handler. A connection that does not
close on `versionchange` blocks the open of the newer version: meanwhile the app says to close the
other tab, and it goes on once that tab is closed. The browser reports this (`blocked`) only for an
open that raises the version, so with the first local schema it cannot happen yet; it starts to apply
with the release that adds the second.

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
`blocked`), e2e "moves the original client's id from localStorage into the database" and "asks to
close the tab that keeps an older local schema open, and goes on once it is closed" (in Chromium: a
connection without a `versionchange` handler, and a tab that acts as the next release because the
test raises the version it asks for by one; the queued change survives the upgrade and is sent once).

**Remaining limitations.** A client before versioning (the original one) cannot understand the
answer: it shows offline and retries; only a reload with the new app helps. The first local schema
has a single upgrade step; the mechanism for the next ones is in place, their tests come with them.
The browser sends `blocked` only to the open request that is first in line: tabs of the newer app
opened while one already waits show "Loading…" without the notice until the older tab is closed.

## Found issues

The defects of the starter code (the `main` branch) in the categories of the task: 1 delivery order
and completeness, 2 retried and parallel pushes, 3 rejection in the middle of the queue, 4
authenticity and access, 5 change-log lifecycle, 6 resources not released, 7 determinism across
environments, 8 client data loss, 9 merging concurrent edits, 10 tests that pass regardless of the
behaviour they name. An item is listed when it is in the starter code, belongs to one of these
categories and breaks something the starter code does; an entry covers every side of its defect.
What the task asks to build, and hardening outside the categories, is described with its area. Each
entry says what is wrong, why it is dangerous, how to reproduce it, how it is fixed, which
alternatives there were, and names the commits.

| Id | Category | Issue | Status |
|---|---|---|---|
| F-25 | 1 | A change that commits after a later one is never delivered | Fixed |
| F-26 | 2 | Parallel copies of one mutation are applied several times | Fixed |
| F-23 | 3 | A rejected mutation fails the whole push and blocks the queue | Fixed |
| F-07 | 4 | Incremental pull returns other sites' changes | Open (known defect) |
| F-08 | 4 | Write access is checked against the `siteId` the client sends | Open (known defect) |
| F-33 | 4 | A client id is not bound to its user | Open (known defect) |
| F-34 | 5 | The GC drops changes without telling anyone | Fixed |
| F-35 | 6 | Notification streams are never released, and keep the server from shutting down | Fixed |
| F-37 | 6 | The web app never closes its client and stream | Fixed |
| F-19 | 7 | Mutators are not deterministic: they make up ids and read the clock | Fixed |
| F-10 | 8 | Pending mutations and the list of rejections are lost on reload | Fixed |
| F-11 | 8 | Two tabs sharing a `clientId` lose each other's mutations | Fixed |
| F-30 | 8 | An interrupted sync loses the user's change | Fixed |
| F-27 | 9 | An edit of one ticket field overwrites another client's edit of the other field | Fixed |
| F-01–F-05 | 10 | Five starter tests cannot fail when the behaviour they name is broken | Fixed |

Ids are the ones used in commit messages, pull requests and code comments, so they have gaps. F-09
is part of F-23, F-20 of F-19, F-32 of F-30 and F-36 of F-35. The other ids name work described with
its area: F-06 in [Changes to starter tests](#changes-to-starter-tests); F-14 and F-15 in
[Data access](#data-access-typeorm); F-16 in [Configuration](#configuration); F-17 in
[With Docker](#with-docker); F-18 in [Checks and tests](#checks-and-tests); F-21 and F-22 in
[3.3.2](#deterministic-simulation-332); F-12, F-28 and F-29 in
[3.3.1](#protocol-correctness-331); F-24 and F-31 in [3.3.5](#merge-semantics-335); F-13, F-38,
F-39 and F-40 in [3.3.3](#offline-first-client-333).

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

### F-23: a rejected mutation fails the whole push and blocks the queue (category 3)

- **What.** On the server, `PushService` does not catch `MutationRejected`: any mutation the mutator
  rejects (`STATUS_CONFLICT`, `NOT_FOUND`, `NEGATIVE_QUANTITY`, `BAD_ARGS`, …) makes the push answer
  500, and the client's last mutation id does not advance. In the client, which already handles a
  `rejected` result, `SyncClient.mutate` derives the next id as `lastMutationId + pending.length + 1`
  (F-09 in the commits): once a rejected mutation leaves the queue without that id advancing, the
  next mutation gets the rejected one's id.
- **Why it is dangerous.** The client never learns the reason and retries the same batch forever;
  every mutation queued after the rejected one is blocked (a poison mutation). A reused id is taken
  for a duplicate, so the server drops the new mutation.
- **Reproduce.** `rejections.spec.ts` and `client-ids.spec.ts` ("tells the client that a create was
  rejected with ID_CONFLICT"); `client.spec.ts`, "never reuses a mutation id after the server
  rejects a mutation". Both were known defects until fixed; in the simulation, the server side is the
  signature `rejected-mutation-500` in the `rejections` and `full` profiles, which no longer tolerate
  it (see [Simulation](#simulation)).
- **Fix.** Each mutation's transaction runs the mutator inside a savepoint. A rejection rolls back
  to it, which undoes the mutator's writes and the locks they took, and the same transaction then
  advances the client's last mutation id, exactly as an application does: the rejected mutation is
  final, and the ones after it are applied. The answer names the reason:
  `{ id, status: 'rejected', code, message, details? }` (codes and details in
  [3.3.5](#merge-semantics-335)), and the client drops the mutation from its queue and keeps the
  rejection for the user. In the client, ids come from a counter that only grows, stored with the
  queue (F-10): each `mutate` takes the next one, and an answer of the server can only move the
  counter past its last applied id, never back. The characterization test "leaves no trace of a
  mutation that the mutator rejects" changed with this fix: it pinned the 500 behaviour (last
  mutation id left at 1) and now expects the rejection in the answer and the id advanced. In the
  simulation, rejections are checked by code: a profile may only see the codes its actions can cause
  (`unexpected-rejection`).
- **Alternatives.** Rolling back the whole batch: one bad mutation would still block every other
  one. A transaction per mutation without a savepoint, recording the rejection in a second
  transaction: between the two, a retried copy of the mutation could run again. Answering 4xx for
  the batch: the client could not tell which mutation was refused. For the ids, keeping the formula
  and relying on the server to advance its id on a rejection: any answer that removes a mutation from
  the queue before the id catches up (a lost response, a future server) would reuse an id again.
  Random ids per mutation: the server could no longer tell a gap from a duplicate, and ordering would
  need another field.
- **Commits.** `1a3c31e`, `34047d5` (tests), `5120e40` (`ID_CONFLICT` test), `c0e1b7d` (simulation
  corpus), `9df3a24` (client fix), `3c0b884` (rejection format), `78ef268` (savepoints), `0abb406`
  (server fix).

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

### F-33: a client id is not bound to its user (category 4)

- **What.** The server takes any client id with any token. The `clients` row records the user who
  pushed first, but nothing checks it. Another user who knows a client id can push mutations under
  it; the owner's next mutation with the same id is then answered `duplicate` and dropped by the
  owner's client. Pull also returns the last mutation id of any client id.
- **Why it is dangerous.** A user can make another user's changes disappear without anyone being
  told. Client ids are random UUIDs, so this needs one to leak (for example from a log of pull URLs).
- **Reproduce.** `client-ownership.spec.ts`, "does not let another user's push take the next
  mutation id of the owner's client" (known defect, owner `access-control`).
- **Fix.** Not fixed yet; owned by the access-control change: 403 for a client id that belongs to
  another user, in push and pull. Until then, only the client's owner is answered with the stored
  outcome of a handled mutation (rejection details include stored field values); anyone else gets a
  bare `duplicate` (`client-ownership.spec.ts`, "never tells another user the outcome of the owner's
  mutations").
- **Commits.** `b481bba` (the known-defect test and the owner-only replay).

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

### F-35: notification streams are never released, and keep the server from shutting down (category 6)

- **What.** `StreamService` added every stream's response to a set and never removed it; nothing was
  written to an idle stream. And `app.close()` closes the HTTP server, which waits for every open
  connection, while an event stream never ends (F-36 in the commits).
- **Why it is dangerous.** Every reload of a page left a subscriber behind for the life of the
  process: memory grows, and every notification writes to dead sockets. Without traffic a proxy
  drops an idle stream, and neither end notices a dead connection. A deploy or restart hangs until
  the orchestrator kills the process, which cuts the requests in progress too.
- **Reproduce.** `stream.spec.ts` (integration, over real HTTP): a client goes away and the count
  stays at 1; a hundred connections and closes; no byte on an idle stream; "lets the application
  close while a stream is open".
- **Fix.** The stream is a `@Sse()` Observable: Nest unsubscribes when the connection closes, and the
  teardown removes the subscriber. The handler is synchronous, since Nest 10 listens for the close
  only once the handler has returned its Observable. An idle stream gets a `heartbeat` event every
  `STREAM_HEARTBEAT_MS` (Nest 10 cannot write SSE comments); pokes are merged within 250 ms; a client
  whose writes stay backed up for a whole interval is dropped. On shutdown,
  `StreamService.onModuleDestroy` ends every stream and refuses new ones; how the HTTP server then
  closes is part of [3.3.3](#offline-first-client-333).
- **Alternatives.** Keeping `res.write` and removing the subscriber on `res.on('close')`: works, but
  bypasses the framework's SSE support and its backpressure handling. For the shutdown,
  `forceCloseConnections: true` (a standard Nest option): destroys every socket, also those of pushes
  in the middle of their answer.
- **Commits.** `0da3a2d`, `cf610a7` (tests), `4fdea61`, `d1f61da` (fixes).

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
- **Alternatives.** One client in a module variable for the life of the page: strict mode would no
  longer make two, but a change of token still has to dispose of the old one. Leaving it to the page
  unload: the browser closes the connections then, but not when the token changes.
- **Commits.** `26d01b8` (test), `4e8aaac`, `e84f17b` (fix).

### F-19: mutators are not deterministic: they make up ids and read the clock (category 7)

- **What.** `ticket.create` called `crypto.randomUUID()` itself: the client ran it once per
  recomputation of its optimistic view and the server once more, so every run produced another id.
  `createdAt` and `updatedAt` came from `new Date()` inside the mutators (F-20 in the commits); on
  the server, a row's data took the Node clock while its change-log entry
  (`created_at DEFAULT now()`) and the GC cutoff took Postgres's clock.
- **Why it is dangerous.** An optimistic ticket changed its id on every render, so its link broke
  at once; edits and parts added to it before the first sync named an id the server never stored
  and were refused (`NOT_FOUND`); after the sync the ticket "jumped" to the server's id. The
  optimistic row changed its timestamps on every recomputation of the view, the client and the
  server stored different times for one change, two clocks on one server disagree under skew, and
  nothing could be driven by a test clock.
- **Reproduce.** Ids: `mutators.spec.ts` ("creates the ticket under the id the client chose",
  "writes the same ticket every time…"), `client.spec.ts` ("keeps an optimistic ticket under the id
  the caller chose"), `client-ids.spec.ts` ("stores a created ticket under the id the client
  chose"). Clocks: `mutators.spec.ts` ("takes the timestamps … from the transaction"),
  `client.spec.ts` ("keeps the timestamps of an optimistic ticket stable…"), `server-clock.spec.ts`
  ("stamps a mutation's row and its log entry with one server clock"). The property tests in
  `determinism.spec.ts` run every mutator with `Math.random`, `Date` and `crypto` stubbed out. With
  the old id put back they fail on a minimal `ticket.create`, and so does a baseline simulation
  seed; with the old clock put back, one simulation seed gives two different traces
  (`detection.spec.ts`).
- **Fix.** `ticket.create` takes a required UUID `id` that the caller generates before queueing (the
  web app uses `crypto.randomUUID()`). Since ids now come from the client, the server must never let
  one id name two rows: creates go through `MutatorTx.insert`, which the server executes as
  `INSERT … ON CONFLICT DO NOTHING RETURNING` and rejects with `ID_CONFLICT` when the id is taken by
  a live row, a deleted row (tombstone) or a concurrent insert (it waits for that transaction and
  then sees the conflict). The original upsert would have let a create overwrite another site's
  ticket or revive a deleted one; `client-ids.spec.ts` checks both and 20 rounds of two concurrent
  creates with one id (exactly one applies). Time comes from `MutatorTx.now()`: on the client, the
  time the mutation was queued, kept with it; on the server, a `Clock` provider (`SystemClock` in
  production), read once per mutation and also used for `change_log.created_at` and the GC cutoff.
  An ESLint override forbids `Date`, `crypto`, `performance`, `globalThis`, timers and
  `Math.random()` in the mutators file (`mutator-lint.spec.ts` checks that the rules report each of
  them).
- **Alternatives.** A temporary client id that the server maps to a real one: every later queued
  mutation that names the ticket would need rewriting. Catching the unique violation (23505) instead
  of `DO NOTHING`: the error aborts the transaction, so it needs a savepoint around every insert. A
  `SELECT … FOR UPDATE` existence check: it locks nothing when the row does not exist yet, so two
  concurrent creates both pass it. The client sends its own time and the server keeps it: client
  clocks are wrong and untrusted. Postgres `now()` everywhere: the mutator runs in Node and would
  need the time passed in anyway, and `now()` is the transaction's start time.
- **Protocol change.** `ticket.create` requires `id`.
- **Commits.** `6d3bf48`, `b8479c4` (tests), `5120e40`, `7f88005` (fixes), `abafac7` (lint rules).

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

### F-30: an interrupted sync loses the user's change (category 8)

- **What.** Two ways. The client dropped a mutation from its queue as soon as the push answered that
  it was applied, and again as soon as any pull page reported a last mutation id covering it, even
  when the change itself was still on a later page: its view is the pulled state plus the queue, so
  until a later pull delivered the change the user's edit was gone from the screen. And the client
  stored its last applied mutation id only after a completed pull (F-32 in the commits): when a push
  was applied, the pull after it failed and the page was reloaded, it numbered again after the stale
  id; the server answered the next mutation as a duplicate of the old one with that id, and the
  client dropped it.
- **Why it is dangerous.** Interrupted syncs are the normal case for this client (a dropped
  connection between push and pull, or between two pages). The user sees the change vanish and may
  enter it again, which creates a real duplicate; or, after a reload, a new change is shown as synced
  although the server never applies it, and nobody is told.
- **Reproduce.** `acknowledgement.spec.ts` and `reload.spec.ts` in `packages/sync-core/test`.
- **Fix.** An applied (or duplicate) result carries the change-log version of the mutation's last
  change. The client keeps the mutation in its queue, applied optimistically but not sent again,
  until its cursor reaches that version, and then drops it, so it is never shown twice either. A
  mutation without a version (it changed nothing) or with a version the cursor already passed is
  dropped at once. The last mutation id a pull reports removes mutations whose push answer was lost
  only on the last page (`hasMore` false): that page comes from the same snapshot as the id, and the
  pages before it held every change up to it. The client also stores its state, the last applied id
  included, right after every push answer, so ids after a reload continue after the last one the
  server handled.
- **Alternatives.** Using only the pull's last mutation id on the last page: a client that never
  reaches the end of the log under constant writes would never shorten its queue. Keeping the
  server's rows of a mutation in the push answer: the answer would grow with the mutation and
  duplicate what the pull delivers. For the ids, storing only the next one: the same effect, but a
  second storage format next to the state. Random ids: the server could no longer tell a gap from a
  duplicate (see F-23).
- **Commits.** `ec9fe40`, `479a024` (tests), `9ad66be`, `5a998ac` (fixes).

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

### F-01–F-05: five starter tests cannot fail when the behaviour they name is broken (category 10)

- **Why it is dangerous.** The suite reported access, merge and protocol rules as tested while they
  were broken or unchecked, so a change that broke them stayed green.
- **Reproduce.** `scripts/audit-starter-tests.sh` breaks the behaviour each test is named after and
  runs the starter test and its replacement (the table in
  [Changes to starter tests](#changes-to-starter-tests)).

| Id | Starter test | Why it could not fail | Fix, and the alternative not taken | Commits |
|---|---|---|---|---|
| F-01 | `pull.spec.ts`, "only returns changes for sites the user can access" | The database was mocked so that every query returned no rows: a pull that ignores access entirely still returns nothing (it did: F-07) | Replaced by `pull-access.spec.ts` on Postgres: the initial pull is filtered by site, the incremental one is known defect F-07. A mock that evaluates `WHERE` would re-implement SQL and test the mock | `1bac9ad` |
| F-02 | `mutators.spec.ts`, "rejects an invalid status transition" | The assertion sat in a `catch` with no assertion count, so an allowed transition passed; the other rejection tests accepted any `MutationRejected`, whatever its code, which clients act on | Every rejection test requires the exact code and an unchanged state; "creates a ticket" checks that one row is written. `expect.assertions(1)` alone would leave codes and state unchecked | `9766718` |
| F-03 | `client.spec.ts`, "numbers local mutations sequentially" | It counted rows and pending mutations and never read an id (the ids the server deduplicates by): it passed with every id equal to 1; "shows a locally created ticket…" counted rows only | A recording transport captures what is pushed and the test expects ids `[1, 2, 3]`; the optimistic create checks the row's content. Reading the client's private queue would tie the test to its internals, not to what the server receives | `a96263e` |
| F-04 | `access.spec.ts`, "rejects a mutation on a site the user cannot access" | The fake database answered every query alike and ignored the role; the test only varied the client's `siteId` argument, pinning the trust in it (F-08). The admin branch was untested | Renamed to what they check; the fake answers by table and user; admin and missing-`siteId` cases added. The real rule is tested on Postgres as known defect F-08. Dropping the unit tests for the Postgres ones would leave the `siteId` argument and the admin branch without a test that runs with no database | `9edc67e` |
| F-05 | `sync.integration.spec.ts`, "sync protocol (integration)" | It ran `SELECT 1`, and was skipped without `DATABASE_URL`, so CI stayed green with no integration test | A harness with a database per test file, the real app and fixtures; characterization tests of authentication, push, pull, duplicates, order, malformed input, atomicity and the GC; `REQUIRE_DB=1` makes a missing database a failure. Failing every run without a database would keep the unit tests from running on a machine that has none | `d9d4b23`, `a9c598a` |

## Changes to starter tests

| Starter test | Change | Reason |
|---|---|---|
| `packages/sync-core/test/mutators.spec.ts` | Rejection tests require the exact code and unchanged state; "creates a ticket" checks that one row is written | F-02 |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…" | Checks the row content, not only the count | F-03 |
| `packages/sync-core/test/client.spec.ts` "numbers local mutations sequentially" | Checks the ids the client pushes | F-03 |
| `packages/sync-core/test/client.spec.ts` two `it.todo` | Real tests, first tracked as known defects F-10 and F-11 (`f943f8d`) | An `it.todo` never runs: both behaviours read like a specification, were broken and were checked by nothing (F-06 in the commits) |
| `packages/sync-core/test/mutators.spec.ts` "creates a ticket in the open status" | Passes an `id`; the fake transaction implements `insert` and `now` | Protocol change of F-19: `ticket.create` requires a client-chosen id and writes through `MutatorTx.insert`; timestamps come from `MutatorTx.now` (F-19) |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…", "numbers local mutations sequentially" | Every `ticket.create` passes an `id` | Protocol change of F-19 |
| `packages/sync-core/test/mutators.spec.ts` "creates a ticket in the open status" | Reads the created row with optional chaining (`created?.status`) | `sync-core` compiles with `noUncheckedIndexedAccess`: an array element may be `undefined`, so the type checker rejects the unguarded access |
| `packages/sync-core/test/client.spec.ts` `OfflineTransport` | Implements `snapshot` (it fails like the other requests) | Protocol change of F-34: a `Transport` also reads snapshots, and a client without a stored state starts with one |
| `packages/sync-core/test/client.spec.ts` (all) | Clients are disposed in `afterEach`, not at the end of the test body: a failing assertion skipped `dispose()`, the client's retry timer stayed alive and Jest never exited | A failing test must fail, not hang |
| `packages/sync-core/test/client.spec.ts` (all that call `mutate`) | `await client.mutate(...)`; the tests that read the view right after it are `async`; the unsendable-arguments test expects a rejection instead of a throw | The queue is written to IndexedDB before a mutation is shown, so `mutate` is asynchronous (F-10) |
| `packages/sync-core/test/client.spec.ts` fake transports | Pull answers and snapshot pages carry `head` | Protocol change of the offline-client work: the head bounds every sync under constant writes |
| `packages/sync-core/test/client.spec.ts` "retries and stamps optimistic rows…" | The client gets `random: () => 0.5` and the retry comes after 500 ms instead of 5 s | Retries use exponential backoff with jitter (task 3.3.3) instead of a fixed 5 s |
| `packages/sync-core/test/client.spec.ts` known defects (reload, two tabs, a request that never answers) | They become regular tests; the reload test waits for `ready`, the timeout test uses the client's clock and checks the `TIMEOUT` error | Fixed by the offline-client change |
| `e2e/ticket-sharing.spec.ts` | Expects `synced · 0 pending` instead of `idle · 0 pending` | The status line shows the indicator of task 3.3.3 |
| `packages/sync-core/test/client.spec.ts` (all that name a client or answer with ids), `apps/server/test/access.spec.ts` | The client id `c1` becomes a UUID constant, and the mutation ids of fake answers and mutations are built with `asMutationId`; no assertion changed | Mutation and client ids are branded types, so a version cannot stand in for a mutation id; a client id is a lower-case UUID (the server accepts only UUIDs, see [3.3.1](#protocol-correctness-331)) |
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
| `stuck-request` | a client waits forever on a request that never completes | — (fixed: requests time out) |
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
  simulation: an id made up by the mutator fails a baseline run, a wall-clock timestamp (both
  F-19) makes one seed give two different traces, and a `ticket.update` that empties the
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

Run again (2026-11-28) once mutation and client ids became types of their own in `sync-core` and the
simulation: the same counts and per-run figures in every profile, as expected of a change of types.

The same search before the change (no reloads, tabs or stream in the simulation): `baseline` and
`rejections` 1000 / 1000, `multi-site` 119 without violations (F-07 in 881), `full` 105 (F-07 in 762,
`stuck-request` in 370).

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
| `full` | 137 / 1000 | `foreign-site-rows` (F-07): 729; `stuck-request`: 359 | 0.36 | 1.57 | 405 ms |

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
| `full` | 100 / 1000 | `foreign-site-rows` (F-07): 777; `stuck-request`: 415 | `foreign-site-rows`: 0, 1, 2; `stuck-request`: 0, 1, 3 | 204 ms |

Per run on average: about 90 fault-phase steps, 4.5 dropped requests, 1.7 duplicates, 1.7 held
copies redelivered later, 2.9 dropped answers, 0.9 bad gateways, 0.9 truncated bodies, one link down
and half a one-way partition; 2.6 writes per run (`baseline`) to a row another client wrote last; in
the rejection profiles about 4 mutations per run rejected by the server, each with a code the
profile's actions can cause.

Before the protocol change, the same search from seed 1 found `rejected-mutation-500` (F-23) in 703
of 1000 `rejections` runs and 644 of 1000 `full` runs (first path 0; for example
`npm run sim -- --profile full --seed 1 --path 3 --trace` on the commit before `0abb406` shows the
request that hung without a timeout, together with F-23 and F-07).

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
  (`JSON_BODY_LIMIT_BYTES`). The upgrade path is Node 22 or 24 LTS, NestJS 11 and a current Next.js
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
- Three defects are reproduced but not fixed yet (F-07, F-08, F-33, all of the access-control
  change); each is a known-defect test with an owner and is listed by every test run.
- Writes are serialized on the change log's head for the last statement of each mutation, which
  bounds write throughput per database (see [3.3.1](#protocol-correctness-331)).
- Offline client (see [3.3.3](#offline-first-client-333) and [3.3.7](#schema-evolution-337)): it
  needs IndexedDB, Web Locks and BroadcastChannel (secure contexts); pokes come only from the server
  instance that applied a change, so with several instances an idle client may not learn of a change
  until something else makes it sync; signing out with unsynced changes discards them after a
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
