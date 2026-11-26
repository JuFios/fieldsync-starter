import {
  ALLOWED_TRANSITIONS,
  isMutatorName,
  MUTATORS,
  MutationRejected,
  mutatorNamed,
  type MutatorTx,
} from '../src/mutators';
import type { EntityName, Row, TicketStatus } from '../src/types';

/** The time a FakeTx reports; mutators must take every timestamp from it. */
const TX_TIME = '2030-01-02T03:04:05.678Z';

class FakeTx implements MutatorTx {
  readonly rows = new Map<string, Row>();

  constructor(initial: Array<[EntityName, string, Row]> = []) {
    for (const [entity, id, row] of initial) this.rows.set(`${entity}/${id}`, row);
  }

  now() {
    return TX_TIME;
  }

  get(entity: EntityName, id: string) {
    return this.rows.get(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row) {
    this.rows.set(`${entity}/${id}`, row);
  }

  insert(entity: EntityName, id: string, row: Row) {
    const key = `${entity}/${id}`;
    if (this.rows.has(key)) throw new MutationRejected('ID_CONFLICT', `${entity} ${id} already exists`);
    this.rows.set(key, row);
  }

  del(entity: EntityName, id: string) {
    this.rows.delete(`${entity}/${id}`);
  }
}

const TICKET = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

const ticket = (status: string): Row => ({ id: TICKET, siteId: SITE, title: 't', description: '', status });

/** Runs a mutator that must reject and returns the rejection, failing the test if it does not throw. */
function rejectionOf(run: () => void): MutationRejected {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(MutationRejected);
  return thrown as MutationRejected;
}

describe('ticket mutators', () => {
  it('creates a ticket in the open status', () => {
    const tx = new FakeTx();
    MUTATORS['ticket.create'].apply(tx, { id: TICKET, siteId: SITE, title: 'Broken pump', description: '' });
    expect(tx.rows.size).toBe(1);
    const [created] = [...tx.rows.values()];
    expect(created.status).toBe('open');
    expect(created.siteId).toBe(SITE);
  });

  it('creates the ticket under the id the client chose', () => {
    const tx = new FakeTx();
    MUTATORS['ticket.create'].apply(tx, { id: TICKET, siteId: SITE, title: 'Broken pump', description: '' });
    expect([...tx.rows.keys()]).toEqual([`ticket/${TICKET}`]);
    expect(tx.get('ticket', TICKET)?.id).toBe(TICKET);
  });

  it('writes the same ticket every time the same create is applied', () => {
    const args = { id: TICKET, siteId: SITE, title: 'Broken pump', description: '' };
    const first = new FakeTx();
    const second = new FakeTx();
    MUTATORS['ticket.create'].apply(first, args);
    MUTATORS['ticket.create'].apply(second, args);
    expect([...second.rows]).toEqual([...first.rows]);
  });

  it('rejects a create with an id that is already taken', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('done')]]);
    const err = rejectionOf(() =>
      MUTATORS['ticket.create'].apply(tx, { id: TICKET, siteId: SITE, title: 'Again', description: '' }),
    );
    expect(err.code).toBe('ID_CONFLICT');
    expect(tx.get('ticket', TICKET)?.status).toBe('done');
  });

  it('takes the timestamps of a created ticket from the transaction', () => {
    const tx = new FakeTx();
    MUTATORS['ticket.create'].apply(tx, { id: TICKET, siteId: SITE, title: 'Broken pump', description: '' });
    expect(tx.get('ticket', TICKET)).toMatchObject({ createdAt: TX_TIME, updatedAt: TX_TIME });
  });

  it('takes the update time of an edited ticket from the transaction', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('open')]]);
    MUTATORS['ticket.update'].apply(tx, { id: TICKET, siteId: SITE, title: 'Renamed', description: '' });
    expect(tx.get('ticket', TICKET)?.updatedAt).toBe(TX_TIME);
    MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from: 'open', to: 'in_progress' });
    expect(tx.get('ticket', TICKET)?.updatedAt).toBe(TX_TIME);
  });

  it('rejects an update for a ticket that does not exist', () => {
    const tx = new FakeTx();
    const err = rejectionOf(() =>
      MUTATORS['ticket.update'].apply(tx, { id: TICKET, siteId: SITE, title: 'x', description: '' }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(tx.rows.size).toBe(0);
  });

  it('moves a ticket along an allowed transition', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('open')]]);
    MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from: 'open', to: 'in_progress' });
    expect(tx.get('ticket', TICKET)?.status).toBe('in_progress');
  });

  it('rejects an invalid status transition', () => {
    const tx = new FakeTx([['ticket', TICKET, ticket('done')]]);
    const err = rejectionOf(() =>
      MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from: 'done', to: 'in_progress' }),
    );
    expect(err.code).toBe('INVALID_TRANSITION');
    expect(tx.get('ticket', TICKET)?.status).toBe('done');
  });
});

describe('ticket status machine', () => {
  const STATUSES: TicketStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
  /** The whole table, written out, so a change to the state machine has to change this test. */
  const EXPECTED: Record<TicketStatus, TicketStatus[]> = {
    open: ['in_progress', 'cancelled'],
    in_progress: ['done', 'open', 'cancelled'],
    done: ['open'],
    cancelled: [],
  };

  it('allows exactly the documented transitions', () => {
    expect(ALLOWED_TRANSITIONS).toEqual(EXPECTED);
  });

  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s -> %s is applied exactly when the table allows it', (from, to) => {
    const tx = new FakeTx([['ticket', TICKET, ticket(from)]]);
    const run = () => MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from, to });
    if (EXPECTED[from].includes(to)) {
      run();
      expect(tx.get('ticket', TICKET)).toMatchObject({ status: to, updatedAt: TX_TIME });
    } else {
      const err = rejectionOf(run);
      expect({ code: err.code, details: err.details }).toEqual({
        code: 'INVALID_TRANSITION',
        details: { from, to, allowed: EXPECTED[from] },
      });
      expect(tx.get('ticket', TICKET)?.status).toBe(from);
    }
  });

  it.each(STATUSES)(
    'rejects a change made from an outdated status with the current one and what it allows (now %s)',
    (current) => {
      const from = STATUSES.find((s) => s !== current) as TicketStatus;
      const tx = new FakeTx([['ticket', TICKET, ticket(current)]]);
      const err = rejectionOf(() =>
        MUTATORS['ticket.setStatus'].apply(tx, { id: TICKET, siteId: SITE, from, to: 'open' }),
      );
      expect({ code: err.code, details: err.details }).toEqual({
        code: 'STATUS_CONFLICT',
        details: { current, allowed: EXPECTED[current] },
      });
      expect(tx.get('ticket', TICKET)?.status).toBe(current);
    },
  );
});

describe('part mutators', () => {
  it('rejects a part whose id is already taken instead of reporting it as added', () => {
    const existing = { id: PART, ticketId: TICKET, siteId: SITE, name: 'Seal', quantity: 1 };
    const tx = new FakeTx([
      ['ticket', TICKET, ticket('open')],
      ['part', PART, existing],
    ]);
    const err = rejectionOf(() =>
      MUTATORS['part.add'].apply(tx, { id: PART, ticketId: TICKET, siteId: SITE, name: 'Valve', quantity: 5 }),
    );
    expect(err.code).toBe('ID_CONFLICT');
    expect(tx.get('part', PART)).toEqual(existing);
  });

  it('does not let a quantity go below zero', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    const err = rejectionOf(() => MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta: -2 }));
    expect({ code: err.code, details: err.details }).toEqual({
      code: 'NEGATIVE_QUANTITY',
      details: { quantity: 1, delta: -2 },
    });
    expect(tx.get('part', PART)?.quantity).toBe(1);
  });

  it('adds to the quantity', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta: 3 });
    expect(tx.get('part', PART)?.quantity).toBe(4);
  });
});

describe('mutatorNamed', () => {
  it.each(Object.keys(MUTATORS))('finds %s', (name) => {
    expect(mutatorNamed(name)).toBe(MUTATORS[name as keyof typeof MUTATORS]);
    expect(isMutatorName(name)).toBe(true);
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', '', 'ticket.Create'])(
    'finds nothing for %j, inherited names included',
    (name) => {
      expect(mutatorNamed(name)).toBeUndefined();
      expect(isMutatorName(name)).toBe(false);
    },
  );
});
