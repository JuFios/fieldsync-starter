import { fc, test } from '@fast-check/jest';
import { MUTATORS, MutationRejected, partsInState, type MutatorTx } from '../src/mutators';
import type { EntityName, MutatorName, Row, TicketStatus } from '../src/types';

/**
 * Mutators run on the client (optimistically, and again on every recomputation of the view) and
 * on the server (authoritatively). From the same arguments and state they must produce the same
 * outcome, either the same writes or a rejection with the same code, so they may not read
 * randomness or a clock themselves: ids come from the arguments and time from the transaction.
 *
 * Property-based (fast-check through @fast-check/jest): arguments and prior state are generated,
 * including invalid and hostile values. A failure prints the seed and path that replay it.
 */

const SITES = ['33333333-3333-4333-8333-333333333333', '66666666-6666-4666-8666-666666666666'];
const TICKETS = ['11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777'];
const PARTS = ['22222222-2222-4222-8222-222222222222', '88888888-8888-4888-8888-888888888888'];
const NEW_IDS = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
const STATUSES: TicketStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
const NAMES = Object.keys(MUTATORS) as MutatorName[];
const TIME = '2030-06-01T12:00:00.000Z';

type Write = [op: 'put' | 'insert' | 'del', entity: EntityName, id: string, row?: Row];
type Outcome = { writes: Write[] } | { rejected: string };

class RecordingTx implements MutatorTx {
  readonly writes: Write[] = [];
  private readonly rows: Map<string, Row>;

  constructor(state: ReadonlyMap<string, Row>) {
    this.rows = new Map(structuredClone([...state]));
  }

  now(): string {
    return TIME;
  }

  get(entity: EntityName, id: string): Row | undefined {
    return this.rows.get(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row): void {
    this.rows.set(`${entity}/${id}`, row);
    this.writes.push(['put', entity, id, row]);
  }

  insert(entity: EntityName, id: string, row: Row): void {
    if (this.rows.has(`${entity}/${id}`)) throw new MutationRejected('ID_CONFLICT');
    this.rows.set(`${entity}/${id}`, row);
    this.writes.push(['insert', entity, id, row]);
  }

  del(entity: EntityName, id: string): void {
    this.rows.delete(`${entity}/${id}`);
    this.writes.push(['del', entity, id]);
  }

  partsOf(ticketId: string): Row[] {
    return partsInState(this.rows, ticketId);
  }
}

/** Runs a mutator; any exception other than a rejection is a crash and fails the property. */
function outcome(name: MutatorName, args: Record<string, unknown>, state: ReadonlyMap<string, Row>): Outcome {
  const tx = new RecordingTx(state);
  try {
    MUTATORS[name].apply(tx, args);
    return { writes: tx.writes };
  } catch (err) {
    if (err instanceof MutationRejected) return { rejected: err.code };
    throw err;
  }
}

/** Replaces the ambient sources of randomness and time for the duration of `run`. */
function withAmbient<T>(kind: 'forbidden' | 'other-values', run: () => T): T {
  const saved = { random: Math.random, date: globalThis.Date, crypto: globalThis.crypto };
  const forbidden = (what: string) => () => {
    throw new Error(`a mutator used ${what}`);
  };
  if (kind === 'forbidden') {
    Math.random = forbidden('Math.random()');
    globalThis.Date = new Proxy(saved.date, {
      construct: forbidden('new Date()'),
      apply: forbidden('Date()'),
      get: (target, prop, receiver) =>
        prop === 'now' ? forbidden('Date.now()') : (Reflect.get(target, prop, receiver) as unknown),
    });
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  } else {
    // A different but working environment: another random sequence and another wall clock.
    Math.random = () => 0.123456789;
    const OriginalDate = saved.date;
    const Shifted = function (this: unknown, ...args: unknown[]) {
      const instance =
        args.length === 0 ? new OriginalDate(Date.UTC(1999, 11, 31)) : new OriginalDate(args[0] as string);
      return new.target ? instance : instance.toString();
    } as unknown as DateConstructor;
    Object.setPrototypeOf(Shifted, OriginalDate);
    Shifted.now = () => Date.UTC(1999, 11, 31);
    globalThis.Date = Shifted;
  }
  try {
    return run();
  } finally {
    Math.random = saved.random;
    globalThis.Date = saved.date;
    Object.defineProperty(globalThis, 'crypto', { value: saved.crypto, configurable: true, writable: true });
  }
}

// --- arbitraries ---------------------------------------------------------------------------

/** Text users or attackers may send: plain, any Unicode (lone surrogates and NUL included), at the limits. */
const textArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.string({ unit: 'binary', maxLength: 20 }),
  fc.constantFrom('', 'pump\u0000room', 'pump \ud83d', '\ude00', `${'x'.repeat(199)}\u{1F527}`),
  fc.integer({ min: 0, max: 3 }).map((extra) => `${'x'.repeat(4998 + extra)}\u{1F527}tail`),
);

/** Values a field may hold: mostly plausible, sometimes of the wrong type or hostile. */
const anyValue = fc.oneof(
  { weight: 1, arbitrary: fc.anything({ maxDepth: 1 }) },
  { weight: 1, arbitrary: fc.constantFrom('constructor', '__proto__', 'toString', null, -0, Number.NaN) },
);
const idArb = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(...TICKETS, ...PARTS, ...NEW_IDS) },
  { weight: 1, arbitrary: anyValue },
);
const siteArb = fc.oneof({ weight: 8, arbitrary: fc.constantFrom(...SITES) }, { weight: 1, arbitrary: anyValue });
const statusArb = fc.oneof({ weight: 8, arbitrary: fc.constantFrom(...STATUSES) }, { weight: 1, arbitrary: anyValue });
const intArb = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: -1500, max: 1500 }) },
  { weight: 1, arbitrary: anyValue },
);
const textOrAny = fc.oneof({ weight: 8, arbitrary: textArb }, { weight: 1, arbitrary: anyValue });

/** Arguments of a mutator: every field any mutator reads, each possibly missing. */
const argsArb = fc
  .record(
    {
      id: idArb,
      ticketId: idArb,
      siteId: siteArb,
      title: textOrAny,
      description: textOrAny,
      name: textOrAny,
      from: statusArb,
      to: statusArb,
      quantity: intArb,
      delta: intArb,
    },
    { requiredKeys: [] },
  )
  // What reaches a mutator in either environment is JSON (the client queues a JSON snapshot).
  .map((args) => JSON.parse(JSON.stringify(args) ?? '{}') as Record<string, unknown>);

/** Rows that may already exist: tickets and parts with valid shapes, in any status and site. */
const stateArb = fc
  .record({
    tickets: fc.uniqueArray(
      fc.record({
        id: fc.constantFrom(...TICKETS),
        site: fc.constantFrom(...SITES),
        status: fc.constantFrom(...STATUSES),
      }),
      {
        selector: (t) => t.id,
        maxLength: 2,
      },
    ),
    parts: fc.uniqueArray(
      fc.record({
        id: fc.constantFrom(...PARTS),
        ticket: fc.constantFrom(...TICKETS),
        quantity: fc.integer({ min: 0, max: 5 }),
      }),
      { selector: (p) => p.id, maxLength: 2 },
    ),
  })
  .map(({ tickets, parts }) => {
    const rows = new Map<string, Row>();
    for (const t of tickets) {
      rows.set(`ticket/${t.id}`, {
        id: t.id,
        siteId: t.site,
        title: 'Pump',
        description: '',
        status: t.status,
        assigneeId: null,
        createdAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
      });
    }
    for (const p of parts) {
      const ticket = rows.get(`ticket/${p.ticket}`);
      rows.set(`part/${p.id}`, {
        id: p.id,
        ticketId: p.ticket,
        siteId: ticket?.siteId ?? SITES[0],
        name: 'Seal',
        quantity: p.quantity,
      });
    }
    return rows;
  });

const mutationArb = fc.record({ name: fc.constantFrom(...NAMES), args: argsArb, state: stateArb });

const RUNS = { numRuns: 2_000 };

describe('mutator determinism (property-based)', () => {
  test.prop([mutationArb], RUNS)(
    'only ever applies or rejects a mutation: no other exception, for any arguments',
    ({ name, args, state }) => {
      expect(() => outcome(name, args, state)).not.toThrow();
    },
  );

  test.prop([mutationArb], RUNS)(
    'reads no ambient randomness or clock, for any arguments and state',
    ({ name, args, state }) => {
      const expected = outcome(name, args, state);
      expect(withAmbient('forbidden', () => outcome(name, args, state))).toEqual(expected);
    },
  );

  test.prop([mutationArb], RUNS)(
    'gives the same outcome in two environments with different random sources and wall clocks',
    ({ name, args, state }) => {
      const client = outcome(name, structuredClone(args), state);
      const server = withAmbient('other-values', () =>
        outcome(name, JSON.parse(JSON.stringify(args)) as Record<string, unknown>, state),
      );
      expect(server).toEqual(client);
    },
  );

  test.prop([mutationArb], RUNS)(
    'gives the same outcome every time the same mutation is applied to the same state',
    ({ name, args, state }) => {
      expect(outcome(name, args, state)).toEqual(outcome(name, args, state));
    },
  );

  test('generates both outcomes for every mutator, so the properties are not vacuous', () => {
    const seen = new Set(
      fc
        .sample(mutationArb, { numRuns: 5_000, seed: 42 })
        .map(({ name, args, state }) => `${name}:${'writes' in outcome(name, args, state) ? 'applied' : 'rejected'}`),
    );
    expect([...seen].sort()).toEqual(NAMES.flatMap((n) => [`${n}:applied`, `${n}:rejected`]).sort());
  });
});

/**
 * Quantity adjustments carry a delta, not a new quantity, so two technicians who adjust the same
 * part concurrently both count, whichever reaches the server first (task, 3.3.5).
 */
describe('part.adjust is commutative (property-based)', () => {
  const PART = PARTS[0] as string;
  const SITE = SITES[0] as string;
  const adjustAll = (start: number, deltas: readonly number[]) => {
    const tx = new RecordingTx(new Map([[`part/${PART}`, { id: PART, siteId: SITE, quantity: start }]]));
    const rejected = deltas.filter((delta) => {
      try {
        MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta });
        return false;
      } catch (err) {
        if (err instanceof MutationRejected) return true;
        throw err;
      }
    });
    return { quantity: tx.get('part', PART)?.quantity, rejected: rejected.length };
  };
  const deltas = fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 8 });

  test.prop(
    [
      fc.integer({ min: 0, max: 10_000 }),
      deltas.chain((d) => fc.tuple(fc.constant(d), fc.shuffledSubarray(d, { minLength: d.length }))),
    ],
    RUNS,
  )(
    'any order of the same adjustments ends at the same quantity when none of them is rejected',
    (start, [inOrder, shuffled]) => {
      const first = adjustAll(start, inOrder);
      const second = adjustAll(start, shuffled);
      fc.pre(first.rejected === 0 && second.rejected === 0);
      expect(second.quantity).toBe(first.quantity);
      expect(first.quantity).toBe(start + inOrder.reduce((sum, d) => sum + d, 0));
    },
  );

  test.prop([fc.integer({ min: 0, max: 10_000 }), fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 8 })], RUNS)(
    'never rejects an increase, in any order',
    (start, increases) => {
      expect(adjustAll(start, increases)).toEqual({
        quantity: start + increases.reduce((sum, d) => sum + d, 0),
        rejected: 0,
      });
    },
  );
});
