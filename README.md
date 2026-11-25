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

### Checks and tests

| Command | What it runs | Needs |
|---|---|---|
| `npm run lint` | ESLint with type information for all packages, the server, e2e and (via `next lint`) the web app; warnings fail | |
| `npm run format:check` | Prettier check (`npm run format` applies it); Markdown is formatted by hand | |
| `npm run typecheck` | `tsc --noEmit` for sync-core, test-kit, server, web and e2e | |
| `npm run test:unit` | Unit tests of test-kit, sync-core and the server | |
| `npm run test:integration` | Server tests on a real Postgres | `DATABASE_URL` |
| `npm test` | Unit and integration tests; integration suites are skipped (with a notice) without `DATABASE_URL` | |
| `npm run test:e2e` | Playwright, Chromium, against the production builds | `npm run build`, `DATABASE_URL`, `npx playwright install chromium` once |
| `scripts/docker-smoke.sh` | Builds the images, checks them and starts the compose stack | Docker |
| `scripts/audit-starter-tests.sh` | Shows the rewritten starter tests were vacuous (see [Changes to starter tests](#changes-to-starter-tests)) | `DATABASE_URL`, built packages |

`DATABASE_URL` names a maintenance database, e.g.
`postgres://fieldsync:fieldsync@localhost:5432/fieldsync` with `docker compose up -d postgres`.

- **Integration tests** never touch that database's data. Global setup creates a template
  database and migrates it once per run; every test file then gets its own clone
  (`CREATE DATABASE … TEMPLATE`, about 30 ms) and drops it afterwards, so files cannot see each
  other's data and each one behaves the same alone or in any worker. Fixtures write straight to
  the database, independently of the server code under test. The server under test is the real
  application on an ephemeral port. With `REQUIRE_DB=1` (set in CI) a missing `DATABASE_URL` fails
  the run instead of skipping the suites.
- **E2e tests** recreate and migrate a dedicated database (`E2E_DATABASE`, default
  `fieldsync_e2e`) on every run, start the built server and web app, and give every test its own
  sites and users. The web bundle has the API URL compiled in, so build with the default
  `NEXT_PUBLIC_API_URL` (`http://localhost:3001`); ports 3000 and 3001 must be free.
- **Known-defect tests.** A defect that is reproduced but fixed by a later change is tracked with
  `knownDefect({ id, owner, reason }, name, body)` from `@fieldsync/test-kit`. The body asserts the
  correct behaviour. The test passes only while the body fails with an assertion error; any other
  error fails it (a broken harness must not look like a reproduced defect), and a body that passes
  fails it with "defect F-NN appears fixed - flip it". Every run prints the open known defects, and
  CI lists them in the job summary.

## Configuration

The server reads its settings once at startup and validates all of them; any invalid value stops
it with a list of every problem, for example:

```
Invalid configuration:
  - PORT must be an integer from 1 to 65535 (got "x")
  - GC_INTERVAL_MS must be an integer from 1000 to 2147483647 (got "1h")
```

Values come from the environment, then from `apps/server/.env` (read from the working directory
when present; the environment wins). `DATABASE_URL` is a secret: it is never logged or echoed in
errors.

| Server variable | Default | Valid values | Meaning |
|---|---|---|---|
| `PORT` | `3001` | 1–65535 | HTTP port of the API |
| `DATABASE_URL` | required | A `postgres://` or `postgresql://` connection string (libpq rules, e.g. `?host=/var/run/postgresql` for a Unix socket) | Database connection |
| `DB_POOL_MAX` | `20` | 1–1000 | Maximum connections in the server's pool |
| `SEED_DEMO` | `false` | `true`, `false` | Insert demo sites, users and well-known tokens on startup (development only) |
| `CHANGELOG_RETENTION_SECONDS` | `604800` | ≥ 1 | Change-log entries older than this are deleted by the GC |
| `GC_INTERVAL_MS` | `3600000` | 1000–2147483647 | How often the GC runs. At least a second, so a millisecond/second mix-up cannot turn the GC into a load test; at most what `setInterval` accepts |

Docker compose reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`,
`SERVER_PORT`, `WEB_PORT`, `SEED_DEMO` and `NEXT_PUBLIC_API_URL` (all with defaults; see
`.env.example`). The web app has one setting, `NEXT_PUBLIC_API_URL`, compiled into the bundle at
build time (`apps/web/.env.example`).

Test settings: `DATABASE_URL`, `REQUIRE_DB`, `E2E_DATABASE`, `E2E_WEB_PORT`.

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
  both apply the same pending migrations. A run waits at most 10 minutes for another one and then
  fails with a message naming the lock, so a stuck run cannot hang later deploys silently; failing
  to release the lock never replaces the outcome of the migrations (Postgres releases it with the
  connection).
- `migrationsTransactionMode: 'each'`: in the default `all` mode TypeORM refuses any migration
  that sets `transaction = false`.
- A TypeORM logger that never writes query parameters (they carry tokens and user data).
- The initial migration is the original schema, idempotent, so it adopts a database created by the
  original server without changing its schema or data (tested on a populated database).

**Why not `@nestjs/typeorm`.** Without entities it only provides dependency injection of the
`DataSource`. By default it retries a failed connection 9 times, 3 s apart, on any error
(including a wrong password), which delays a fail-fast start. The migration command and the tests
need the `DataSource` outside Nest anyway, so one factory (`createDataSource`) serves all three.

**Safety of the switch.** The characterization tests of the HTTP API and the access tests were
written against the `pg` implementation and pass unchanged after the switch
(`git diff a9c598a 291d9bb -- apps/server/test/integration/sync.characterization.spec.ts` is
empty).

**Remaining limitations.** TypeORM's `QueryFailedError` carries the failed query's parameters:
anything that serializes whole error objects (structured logging) must drop them. TypeORM is
pinned to an exact version because `Db.tx` relies on how it releases broken connections, which is
covered by tests.

### Server configuration

A small typed loader of our own (`apps/server/src/config.ts`) instead of `@nestjs/config`: the
server has six settings, they must be validated as a whole before Nest starts (so `main` can print
a readable report and exit, and the migration command can use the same rules), and `.env` loading
is Node's own parser (`util.parseEnv`). The loader is plain TypeScript and fully unit-tested.

### Pending decision records

Protocol correctness (3.3.1), deterministic simulation (3.3.2), offline-first client (3.3.3),
partial replication (3.3.4), merge semantics (3.3.5), change-log lifecycle (3.3.6), schema
evolution (3.3.7) and SSE authentication are recorded with the changes that implement them.

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
| F-09 | 2 | Client reuses a mutation id after a rejection | Open (known defect) |
| F-10 | 8 | Pending mutations are lost on reload | Open (known defect) |
| F-11 | 8 | Two tabs sharing a `clientId` lose each other's mutations | Open (known defect) |
| F-12 | 3 | Mutator names from `Object.prototype` crash the push | Open (known defect) |
| F-13 | 6 | A request that never answers blocks syncing forever | Open (known defect) |
| F-14 | other | A failed rollback replaces the original error | Fixed |
| F-15 | other | A dropped database connection crashes the server | Fixed |
| F-16 | other | Unvalidated settings: an invalid GC interval runs the GC every millisecond | Fixed |
| F-17 | other | Docker images run as root and bake in local `.env` files; no migrate step, no healthchecks | Fixed |
| F-18 | other | CI was not reproducible and did not typecheck the web app | Fixed |

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
  can access" (known defect).
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
  mutation" (known defect).
- **Fix.** Not fixed yet; owned by the protocol change. **Commits.** `1a3c31e` (test).

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
- **Reproduce.** `mutator-lookup.spec.ts` (known defect).
- **Fix.** Not fixed yet; owned by the protocol change. **Commits.** `791bd98` (test).

### F-13: a request that never answers blocks syncing forever (category 6)

- **What.** `HttpTransport` has no timeout or abort signal; sync attempts are deduplicated, so
  while one request hangs no other is made.
- **Why it is dangerous.** After a half-open connection the client shows "syncing" forever and
  never pushes again until the page reloads.
- **Reproduce.** `client.spec.ts`, "gives up on a request that never answers and retries" (known
  defect).
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
- **Alternatives.** `@nestjs/config` with a schema library: an extra dependency for six settings,
  and validation would run inside Nest's bootstrap rather than before it.
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

## Changes to starter tests

| Starter test | Change | Reason |
|---|---|---|
| `packages/sync-core/test/mutators.spec.ts` | Rejection tests require the exact code and unchanged state; "creates a ticket" checks that one row is written | F-02 |
| `packages/sync-core/test/client.spec.ts` "shows a locally created ticket…" | Checks the row content, not only the count | F-03 |
| `packages/sync-core/test/client.spec.ts` "numbers local mutations sequentially" | Checks the ids the client pushes | F-03 |
| `packages/sync-core/test/client.spec.ts` two `it.todo` | Real tests, tracked as known defects F-10, F-11 | F-06 |
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

Not written yet: the deterministic simulation is added by the simulation change.

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
- Docker base images use the `node:20.19-alpine` tag, not a digest.
- E2e runs on one Postgres share the database name `fieldsync_e2e` unless `E2E_DATABASE` is set;
  two simultaneous runs against the same server would collide.
- Seven defects are reproduced but not fixed yet (F-07 to F-13); each is a known-defect test with
  an owner and is listed by every test run.
