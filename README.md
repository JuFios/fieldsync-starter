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
3. `GET /sync/pull?cursor=N&clientId=…` returns changes with `version > N` for accessible sites.
4. `GET /sync/stream` emits `poke` events so clients pull promptly.

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
| `SEED_DEMO` | `false` | `true`, `false` | Insert demo sites, users and well-known tokens on startup (development only) |
| `CHANGELOG_RETENTION_SECONDS` | `604800` | ≥ 1 | Change-log entries older than this are deleted by the GC |
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
`ValidationPipe` (`APP_PIPE`, `whitelist`, `transform`) validates DTO-typed parameters (the sync
endpoints do not declare DTOs yet, and their input passes through unchanged); both are
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

**Decision: option 3** (decision D-11 of the plan), built on the documented tools of
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

Protocol correctness (3.3.1), offline-first client (3.3.3), partial replication (3.3.4), merge
semantics (3.3.5), change-log lifecycle (3.3.6), schema evolution (3.3.7) and SSE authentication
are recorded with the changes that implement them.

## Found issues

Each issue has an id, the category from the task (1 delivery order and completeness, 2 retried and
parallel pushes, 3 rejection in the middle of the queue, 4 authenticity and access, 5 change-log
lifecycle, 6 resources not released, 7 determinism across environments, 8 client data loss,
9 merging concurrent edits, 10 tests that pass regardless of the behaviour they name; "other" for
everything else), a test that reproduces it, and the commits that reproduce and fix it.

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
| F-10 | 8 | Pending mutations are lost on reload | Open (known defect) |
| F-11 | 8 | Two tabs sharing a `clientId` lose each other's mutations | Open (known defect) |
| F-12 | 3 | Mutator names from `Object.prototype` crash the push | Fixed |
| F-13 | 6 | A request that never answers blocks syncing forever | Open (known defect) |
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
| F-28 | 3 | A batch of long mutations is refused with 413 on every retry, blocking the queue | Fixed |
| F-29 | other | Unvalidated pull parameters and client ids: silent full resyncs and 500s | Fixed |

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
- **Commits.** `1a3c31e` (test).

### F-10: pending mutations are lost on reload (category 8)

- **What.** The client persists the server snapshot and cursor but not the pending queue.
- **Why it is dangerous.** Work done offline disappears when the page reloads.
- **Reproduce.** `client.spec.ts`, "keeps unsynced mutations across a reload" (known defect).
- **Fix.** Not fixed yet; owned by the offline-client change. **Commits.** `f943f8d` (test).

### F-11: two tabs sharing a `clientId` lose each other's mutations (category 8)

- **What.** Tabs share `clientId` and storage but allocate mutation ids independently, so both use
  id 1 and the server drops the second as a duplicate.
- **Reproduce.** `client.spec.ts`, "does not lose mutations when two tabs share one clientId"
  (known defect).
- **Fix.** Not fixed yet; owned by the offline-client change. **Commits.** `f943f8d` (test).

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
- **Commits.** `791bd98` (test).

### F-13: a request that never answers blocks syncing forever (category 6)

- **What.** `HttpTransport` has no timeout or abort signal; sync attempts are deduplicated, so
  while one request hangs no other is made.
- **Why it is dangerous.** After a half-open connection the client shows "syncing" forever and
  never pushes again until the page reloads.
- **Reproduce.** `client.spec.ts`, "gives up on a request that never answers and retries" (known
  defect); in the simulation, the signature `stuck-request` in the `full` profile.
- **Fix.** Not fixed yet; owned by the offline-client change. **Commits.** `22b61c2` (test).

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
  was rejected with ID_CONFLICT"), both known defects; in the simulation, the signature
  `rejected-mutation-500` in the `rejections` and `full` profiles (see [Simulation](#simulation)).
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
- **Commits.** `34047d5` (test), `5120e40` (`ID_CONFLICT` test), `c0e1b7d` (simulation corpus).

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
- **Commits.** `0c6d9f9` (test).

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
- **Commits.** `e5831da` (test).

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
- **Commits.** `acf00e3` (test).

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

## Changes to starter tests

| Starter test | Change | Reason |
|---|---|---|
| `packages/sync-core/test/mutators.spec.ts` | Rejection tests require the exact code and unchanged state; "creates a ticket" checks that one row is written | F-02 |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…" | Checks the row content, not only the count | F-03 |
| `packages/sync-core/test/client.spec.ts` "numbers local mutations sequentially" | Checks the ids the client pushes | F-03 |
| `packages/sync-core/test/client.spec.ts` two `it.todo` | Real tests, tracked as known defects F-10, F-11 | F-06 |
| `packages/sync-core/test/mutators.spec.ts` "creates a ticket in the open status" | Passes an `id`; the fake transaction implements `insert` and `now` | Protocol change of F-19: `ticket.create` requires a client-chosen id and writes through `MutatorTx.insert`; timestamps come from `MutatorTx.now` (F-20) |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…", "numbers local mutations sequentially" | Every `ticket.create` passes an `id` | Protocol change of F-19 |
| `packages/sync-core/test/client.spec.ts` (all) | Clients are disposed in `afterEach`, not at the end of the test body: a failing assertion skipped `dispose()`, the client's retry timer stayed alive and Jest never exited | A failing test must fail, not hang |
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
   | `sync` | A client syncs, as on a server notification (the notification stream itself is not simulated) |
   | `deliver` | The oldest request of a client reaches the network, with a request fault (below) |
   | `respond` | The oldest answer the server produced for a client goes back, with a response fault |
   | `redeliver` | A stale copy of an earlier request reaches the server again |
   | `tick` | Virtual time advances (up to 8 s), firing due timers such as the client's 5 s retry |
   | `link` | A client's link goes down, comes back, or starts losing every answer |

3. **Heal.** Every link comes back and faults stop. Requests and answers are delivered and time
   advances to the next timer until nothing is in transit and no client has pending mutations;
   then every client syncs once more. The system gets 400 steps for this.

**Faults.**

| Kind | Fault | Effect on the server | Effect on the client |
|---|---|---|---|
| Request | `drop-request` | never sees it | `fetch` fails |
| Request | `duplicate` | handles it twice in a row | gets the second answer |
| Request | `hold-copy` | handles it now and once more later (`redeliver`) | gets the first answer |
| Request | `hang` | handles it | never gets an answer; the connection never closes |
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
- **Determinism.** A seed run twice gives the same traces, byte for byte (compared by SHA-256), and
  replaying one run from its seed and path gives the same trace again. The trace holds only semantic facts:
  steps, requests and answers (status, body digest, the class and code of server-side exceptions),
  final client states; no host time or host-specific text.

Each violation has a **signature**:

| Signature | Meaning | Known defect |
|---|---|---|
| `rejected-mutation-500` | a queue never drained because the server answered 500 to a mutation it rejected | F-23 (protocol change) |
| `foreign-site-rows` | a client holds rows of a site its user cannot access | F-07 (access-control change) |
| `stuck-request` | a client waits forever on a request that never completes | F-13 (offline-client change) |
| `livelock` | a queue never drained for another reason | — |
| `divergence` | a client's rows differ from the server's within its sites | — |
| `client-error` | the client code threw (for example while computing its view) | — |

### Profiles

| Profile | Sites, users, clients | Actions | Faults | Tolerated signatures |
|---|---|---|---|---|
| `baseline` | 1 site, 3 technicians, 4 clients (one technician on two devices) | create, edit, add part, increase quantity: nothing the server can reject | all but `hang` | none: must converge on every seed |
| `rejections` | as `baseline` | all, including status races, deletes against edits, adjustments near zero, invalid text | all but `hang` | `rejected-mutation-500` |
| `multi-site` | 2 sites; a technician of each, one of both, an admin; 4 clients | as `baseline` | all but `hang` | `foreign-site-rows` |
| `full` | as `multi-site` | as `rejections` | all, `hang` included | `rejected-mutation-500`, `foreign-site-rows`, `stuck-request` |

A profile may produce only its tolerated signatures; anything else fails. Each tolerated signature
is a known-defect test in the corpus, so the change that fixes the defect sees "appears fixed - flip
it" and removes the signature from the profile. Each profile also has minimums for the average per
seed of its run statistics (every fault kind occurs, timers fire, clients write rows another client
wrote last, the rejection profiles see rejections), so a profile cannot quietly stop exercising what
it is for. Lowering a minimum needs a reason here.

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
  other sites' rows in incremental pulls, a push that always fails, corrupted rows. Each must be
  reported with its signature, a search must stop at the first such run, and the correct server must
  converge on every run of every profile (in `full`, it may only get stuck on hung requests). The
  profile minimums are checked there as averages over 60 runs.
- Every network fault has a test of its own (`network.spec.ts`), and so do the virtual clock
  (`clock.spec.ts`) and the oracle (`oracle.spec.ts`). Shrinking is tested end to end: a failure
  shrinks to fewer steps that still fail, and its seed, path and `replayPath` replay it to the same
  trace.
- Against the real server, putting a determinism defect back into `ticket.create` must fail the
  simulation: an id made up by the mutator (F-19) fails a baseline run, and a wall-clock timestamp
  (F-20) makes one seed give two different traces (`detection.spec.ts`).

### Results

A local search of 1000 runs per profile from seed 1 (`npm run sim -- --profile <name> --seed 1
--runs 1000`, one process per profile in parallel, about 6.5 minutes in all, fast-check
4.11.0) found no violation other than the known defects each profile tolerates:

| Profile | Runs without violations | Known-defect runs | First path (replay with `--seed 1 --path N`) | Time per run |
|---|---|---|---|---|
| `baseline` | 1000 / 1000 | — | — | 196 ms |
| `rejections` | 297 / 1000 | `rejected-mutation-500` (F-23): 703 | 0 | 379 ms |
| `multi-site` | 81 / 1000 | `foreign-site-rows` (F-07): 919 | 0 | 193 ms |
| `full` | 66 / 1000 | `rejected-mutation-500` (F-23): 644; `foreign-site-rows` (F-07): 584; `stuck-request` (F-13): 405 | F-23: 0, F-07: 0, F-13: 3 | 361 ms |

Per run on average: about 91 fault-phase steps, 4.8 dropped requests, 1.7 duplicates, 1.7 held
copies redelivered later, 2.9 dropped answers, 0.9 bad gateways, 0.9 truncated bodies, one link down
and half a one-way partition; 2.5 writes per run (`baseline`) to a row another client wrote last; in
the rejection profiles 86 to 93 mutations per run rejected by the server.

For example, the hung request of F-13 together with F-23 and F-07:

```bash
npm run sim -- --profile full --seed 1 --path 3 --trace
```

### Limitations

- **No real concurrency.** Requests reach the server one at a time, so races between transactions
  (the change-log ordering of category 1, parallel duplicates of category 2) are out of the
  simulation's reach. They need concurrent tests on Postgres: `client-ids.spec.ts` already races two
  creates of one id; the change-log and duplicate races are tested with the protocol change.
- **One server instance**, and the notification stream is modelled as a `sync` step, not
  simulated.
- **Not yet simulated:** page reloads and several tabs (the offline-client change), log compaction
  and long offline periods (the log-lifecycle change), access changes and moving tickets (the
  access-control change), two server instances (the observability change). Each of these changes
  adds its events as new commands.
- Traces are compared within one environment; a different Node.js or Postgres version may change
  response bodies (for example error messages) and with them the trace digest, but not whether a
  run passes. A new fast-check version may generate different scenarios from the same seed, so the
  corpus and the documented paths below hold for the locked version.

## Load test

Not written yet: the load scenario (≥ 200 clients) is added with the observability work.

## Indexes

Not written yet: the indexes for the log, snapshot and access queries are added with the access
control change. The schema currently has the original two indexes (`entities (site_id)`,
`change_log (created_at)`).

## Observability

Not written yet: structured logging, `/metrics` and readiness are added with the observability
work.

## Limitations & what we'd do differently

- **Runtime and framework versions are kept as they are** (Node 20, NestJS 10, Next.js 14) by
  decision; only the lockfile is new. Node 20 left long-term support in April 2026. `npm audit`
  reports 20 known vulnerabilities (1 critical in `next`; high in `body-parser` and `multer`
  through `@nestjs/platform-express`, and in `eslint-config-next`; moderate ones elsewhere). The
  API has no multipart endpoints, so `multer` is never used; request size limits are part of the
  access-control work. The upgrade path is Node 22 or 24 LTS, NestJS 11 and a current Next.js
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
- Eight defects are reproduced but not fixed yet (F-07 to F-13, F-23); each is a known-defect test with
  an owner and is listed by every test run.
