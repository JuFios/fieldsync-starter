import { MUTATORS, MutationRejected, type MutatorTx } from '../src/mutators';
import type { EntityName, Row } from '../src/types';

class FakeTx implements MutatorTx {
  readonly rows = new Map<string, Row>();

  constructor(initial: Array<[EntityName, string, Row]> = []) {
    for (const [entity, id, row] of initial) this.rows.set(`${entity}/${id}`, row);
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
    MUTATORS['ticket.create'].apply(tx, { siteId: SITE, title: 'Broken pump', description: '' });
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

describe('part mutators', () => {
  it('does not let a quantity go below zero', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    const err = rejectionOf(() => MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta: -2 }));
    expect(err.code).toBe('NEGATIVE_QUANTITY');
    expect(tx.get('part', PART)?.quantity).toBe(1);
  });

  it('adds to the quantity', () => {
    const tx = new FakeTx([['part', PART, { id: PART, quantity: 1 }]]);
    MUTATORS['part.adjust'].apply(tx, { id: PART, siteId: SITE, delta: 3 });
    expect(tx.get('part', PART)?.quantity).toBe(4);
  });
});
