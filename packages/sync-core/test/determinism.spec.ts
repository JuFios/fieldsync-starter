import { MUTATORS, MutationRejected, type MutatorTx } from '../src/mutators';
import type { EntityName, MutatorName, Row } from '../src/types';

/**
 * Mutators run on the client (optimistically, and again on every recomputation of the view) and
 * on the server (authoritatively). They must compute the same rows from the same arguments and
 * state, so they may not read randomness or the clock themselves: ids come from the arguments and
 * time from the transaction.
 */

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';

class RecordingTx implements MutatorTx {
  readonly writes: Array<[string, EntityName, string, Row?]> = [];
  private readonly rows = new Map<string, Row>();

  constructor(
    private readonly time: string,
    initial: Array<[EntityName, string, Row]>,
  ) {
    for (const [entity, id, row] of initial) this.rows.set(`${entity}/${id}`, row);
  }

  now(): string {
    return this.time;
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
}

const state = (): Array<[EntityName, string, Row]> => [
  [
    'ticket',
    TICKET,
    {
      id: TICKET,
      siteId: SITE,
      title: 'Pump',
      description: '',
      status: 'open',
      assigneeId: null,
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    },
  ],
  ['part', PART, { id: PART, ticketId: TICKET, siteId: SITE, name: 'Seal', quantity: 2 }],
];

/** One representative call of every mutator; the record type makes a new mutator fail to compile here. */
const CALLS: Record<MutatorName, Record<string, unknown>> = {
  'ticket.create': { id: '44444444-4444-4444-8444-444444444444', siteId: SITE, title: 'New', description: 'd' },
  'ticket.update': { id: TICKET, siteId: SITE, title: 'Renamed', description: 'e' },
  'ticket.setStatus': { id: TICKET, siteId: SITE, from: 'open', to: 'in_progress' },
  'ticket.delete': { id: TICKET, siteId: SITE },
  'part.add': {
    id: '55555555-5555-4555-8555-555555555555',
    ticketId: TICKET,
    siteId: SITE,
    name: 'Valve',
    quantity: 1,
  },
  'part.adjust': { id: PART, siteId: SITE, delta: 3 },
};

/** Replaces the ambient sources of randomness and time with stubs that fail when used. */
function withoutAmbientNondeterminism(run: () => void): void {
  const forbidden = (what: string) => () => {
    throw new Error(`a mutator used ${what}`);
  };
  const saved = { random: Math.random, date: globalThis.Date, crypto: globalThis.crypto };
  const ForbiddenDate = new Proxy(saved.date, {
    construct: forbidden('new Date()'),
    apply: forbidden('Date()'),
    get: (target, prop, receiver) =>
      prop === 'now' ? forbidden('Date.now()') : (Reflect.get(target, prop, receiver) as unknown),
  });
  Math.random = forbidden('Math.random()');
  globalThis.Date = ForbiddenDate;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    run();
  } finally {
    Math.random = saved.random;
    globalThis.Date = saved.date;
    Object.defineProperty(globalThis, 'crypto', { value: saved.crypto, configurable: true, writable: true });
  }
}

describe('mutator determinism', () => {
  it.each(Object.keys(CALLS) as MutatorName[])('%s reads no ambient randomness or clock', (name) => {
    const tx = new RecordingTx('2030-06-01T12:00:00.000Z', state());
    withoutAmbientNondeterminism(() => MUTATORS[name].apply(tx, CALLS[name]));
    expect(tx.writes.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(CALLS) as MutatorName[])(
    '%s writes the same rows in two environments given the same transaction time',
    (name) => {
      const client = new RecordingTx('2030-06-01T12:00:00.000Z', state());
      const server = new RecordingTx('2030-06-01T12:00:00.000Z', state());
      MUTATORS[name].apply(client, structuredClone(CALLS[name]));
      MUTATORS[name].apply(server, JSON.parse(JSON.stringify(CALLS[name])) as Record<string, unknown>);
      expect(server.writes).toEqual(client.writes);
    },
  );
});
