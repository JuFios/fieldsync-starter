import { MUTATORS, MutationRejected, type MutatorTx } from '../src/mutators';
import type { EntityName, MutatorName, Row } from '../src/types';

/**
 * A mutator must reject on the client every argument the server would refuse to store. Otherwise
 * the optimistic state shows a change the server can never apply, and the push fails on the
 * server instead of being rejected with a reason.
 */

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '44444444-4444-4444-8444-444444444444';

class MemoryTx implements MutatorTx {
  readonly rows = new Map<string, Row>([
    [`ticket/${TICKET}`, { id: TICKET, siteId: SITE, title: 'Pump', description: '', status: 'open' }],
    [`part/${PART}`, { id: PART, ticketId: TICKET, siteId: SITE, name: 'Seal', quantity: 2 }],
  ]);

  now() {
    return '2030-01-01T00:00:00.000Z';
  }

  get(entity: EntityName, id: string) {
    return this.rows.get(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row) {
    this.rows.set(`${entity}/${id}`, row);
  }

  insert(entity: EntityName, id: string, row: Row) {
    this.rows.set(`${entity}/${id}`, row);
  }

  del(entity: EntityName, id: string) {
    this.rows.delete(`${entity}/${id}`);
  }
}

function outcome(name: MutatorName, args: Record<string, unknown>): string {
  try {
    MUTATORS[name].apply(new MemoryTx(), args);
    return 'applied';
  } catch (err) {
    if (err instanceof MutationRejected) return err.code;
    throw err;
  }
}

const VALID: Record<MutatorName, Record<string, unknown>> = {
  'ticket.create': { id: NEW_ID, siteId: SITE, title: 'New', description: '' },
  'ticket.update': { id: TICKET, siteId: SITE, title: 'Renamed', description: '' },
  'ticket.setStatus': { id: TICKET, siteId: SITE, from: 'open', to: 'in_progress' },
  'ticket.delete': { id: TICKET, siteId: SITE },
  'part.add': { id: NEW_ID, ticketId: TICKET, siteId: SITE, name: 'Valve', quantity: 1 },
  'part.adjust': { id: PART, siteId: SITE, delta: 1 },
};
const NAMES = Object.keys(VALID) as MutatorName[];

describe('mutator arguments the server cannot store', () => {
  it.each(NAMES)('%s accepts its valid arguments', (name) => {
    expect(outcome(name, VALID[name])).toBe('applied');
  });

  it.each(NAMES)('%s rejects ids that are not UUIDs', (name) => {
    const idFields = ['id', 'siteId', 'ticketId'].filter((field) => field in VALID[name]);
    const outcomes = idFields.map((field) => [field, outcome(name, { ...VALID[name], [field]: 'north-plant' })]);
    expect(outcomes).toEqual(idFields.map((field) => [field, 'BAD_ARGS']));
  });

  const unstorable: Array<[string, string]> = [
    ['a NUL character', 'pump\u0000room'],
    ['an unpaired high surrogate', 'pump \ud83d'],
    ['an unpaired low surrogate', '\ude00 pump'],
  ];

  it.each(unstorable)('rejects a title with %s', (_label, title) => {
    expect(outcome('ticket.create', { ...VALID['ticket.create'], title })).toBe('BAD_ARGS');
    expect(outcome('ticket.update', { ...VALID['ticket.update'], title })).toBe('BAD_ARGS');
  });

  it.each(unstorable)('rejects a description with %s', (_label, description) => {
    expect(outcome('ticket.create', { ...VALID['ticket.create'], description })).toBe('BAD_ARGS');
    expect(outcome('ticket.update', { ...VALID['ticket.update'], description })).toBe('BAD_ARGS');
  });

  it.each(unstorable)('rejects a part name with %s', (_label, name) => {
    expect(outcome('part.add', { ...VALID['part.add'], name })).toBe('BAD_ARGS');
  });

  it('cuts a long description without splitting a character in two', () => {
    const tx = new MemoryTx();
    const description = `${'x'.repeat(4999)}\u{1F600}tail`;
    MUTATORS['ticket.create'].apply(tx, { ...VALID['ticket.create'], description });
    const stored = tx.get('ticket', NEW_ID)?.description as string;
    expect(stored).toBe('x'.repeat(4999));
  });

  it('keeps a character that ends exactly at the length limit', () => {
    const tx = new MemoryTx();
    const description = `${'x'.repeat(4998)}\u{1F600}tail`;
    MUTATORS['ticket.create'].apply(tx, { ...VALID['ticket.create'], description });
    expect(tx.get('ticket', NEW_ID)?.description).toBe(`${'x'.repeat(4998)}\u{1F600}`);
  });
});
