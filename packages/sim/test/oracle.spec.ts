import type { Row } from '@fieldsync/sync-core';
import { canonicalJson, compareWithServer, lostEdits, ticketFieldWrite } from '../src/oracle';
import { convergenceViolations } from '../src/simulation';
import type { StoredRow } from '../src/types';

const NORTH = 'north';
const SOUTH = 'south';

const server: StoredRow[] = [
  { entity: 'ticket', id: 't1', siteId: NORTH, data: { id: 't1', siteId: NORTH, title: 'A', status: 'open' } },
  { entity: 'part', id: 'p1', siteId: NORTH, data: { id: 'p1', siteId: NORTH, quantity: 2 } },
  { entity: 'ticket', id: 't2', siteId: SOUTH, data: { id: 't2', siteId: SOUTH, title: 'B', status: 'open' } },
];

const client = (rows: Array<[string, Row]>) => new Map(rows);
const northRows = (): Array<[string, Row]> => [
  ['ticket/t1', { status: 'open', title: 'A', siteId: NORTH, id: 't1' }],
  ['part/p1', { quantity: 2, siteId: NORTH, id: 'p1' }],
];

describe('compareWithServer', () => {
  it('accepts a client with exactly the rows of its sites, whatever the key order', () => {
    expect(compareWithServer(server, new Set([NORTH]), client(northRows()))).toBeUndefined();
  });

  it('reports a row the client lacks', () => {
    const rows = northRows().slice(0, 1);
    expect(compareWithServer(server, new Set([NORTH]), client(rows))).toEqual({
      missing: ['part/p1'],
      unexpected: [],
      foreign: [],
      different: [],
    });
  });

  it('reports a row with different contents', () => {
    const rows = northRows();
    rows[1] = ['part/p1', { id: 'p1', siteId: NORTH, quantity: 3 }];
    expect(compareWithServer(server, new Set([NORTH]), client(rows))?.different).toEqual(['part/p1']);
  });

  it('reports a row of a site the user cannot access as foreign', () => {
    const rows: Array<[string, Row]> = [
      ...northRows(),
      ['ticket/t2', { id: 't2', siteId: SOUTH, title: 'B', status: 'open' }],
    ];
    expect(compareWithServer(server, new Set([NORTH]), client(rows))).toEqual({
      missing: [],
      unexpected: ['ticket/t2'],
      foreign: ['ticket/t2'],
      different: [],
    });
  });

  it('reports a row the server deleted, in an accessible site, as unexpected but not foreign', () => {
    const rows: Array<[string, Row]> = [...northRows(), ['ticket/gone', { id: 'gone', siteId: NORTH }]];
    expect(compareWithServer(server, new Set([NORTH]), client(rows))).toEqual({
      missing: [],
      unexpected: ['ticket/gone'],
      foreign: [],
      different: [],
    });
  });

  it('expects every site from a user with access to all of them', () => {
    const divergence = compareWithServer(server, new Set([NORTH, SOUTH]), client(northRows()));
    expect(divergence?.missing).toEqual(['ticket/t2']);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('writes undefined as JSON does: null in an array and at the top level', () => {
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('convergenceViolations', () => {
  it('reports only foreign-site-rows when foreign rows are the whole difference', () => {
    const divergence = compareWithServer(server, new Set([NORTH]), client([...northRows(), ['ticket/t2', {}]]));
    if (!divergence) throw new Error('expected a divergence');
    expect(convergenceViolations('c0', divergence).map((v) => v.signature)).toEqual(['foreign-site-rows']);
  });

  it('reports a divergence in the own sites even when the client also holds foreign rows', () => {
    // A known defect that leaks foreign rows (tolerated by some profiles) must not hide a lost row.
    const divergence = compareWithServer(
      server,
      new Set([NORTH]),
      client([
        ['part/p1', { quantity: 2, siteId: NORTH, id: 'p1' }],
        ['ticket/t2', {}],
      ]),
    );
    if (!divergence) throw new Error('expected a divergence');
    const violations = convergenceViolations('c0', divergence);
    expect(violations.map((v) => v.signature)).toEqual(['foreign-site-rows', 'divergence']);
    expect(violations.map((v) => ('client' in v ? v.detail : undefined))).toEqual([
      { missing: [], unexpected: ['ticket/t2'], foreign: ['ticket/t2'], different: [] },
      { missing: ['ticket/t1'], unexpected: [], foreign: [], different: [] },
    ]);
  });

  it('reports a divergence alone when no row is foreign', () => {
    const divergence = compareWithServer(server, new Set([NORTH]), client([]));
    if (!divergence) throw new Error('expected a divergence');
    expect(convergenceViolations('c0', divergence).map((v) => v.signature)).toEqual(['divergence']);
  });
});

describe('ticketFieldWrite', () => {
  const ID = 't1';

  it('takes both fields from a create, and an empty description when it is not a string', () => {
    expect(ticketFieldWrite('ticket.create', { id: ID, title: 'Pump', description: 'Leaks' })).toEqual({
      ticket: ID,
      fields: { title: 'Pump', description: 'Leaks' },
    });
    expect(ticketFieldWrite('ticket.create', { id: ID, title: 'Pump' })?.fields.description).toBe('');
  });

  it('takes only the fields an update carries', () => {
    expect(ticketFieldWrite('ticket.update', { id: ID, title: 'Pump 2', base: { title: 'Pump' } })).toEqual({
      ticket: ID,
      fields: { title: 'Pump 2' },
    });
    expect(ticketFieldWrite('ticket.update', { id: ID, description: '' })?.fields).toEqual({ description: '' });
  });

  it('cuts a long description to 5000 units, one less when the cut splits a surrogate pair', () => {
    const plain = 'a'.repeat(5001);
    expect(ticketFieldWrite('ticket.update', { id: ID, description: plain })?.fields.description).toHaveLength(5000);
    const emoji = `${'a'.repeat(4999)}😀b`;
    expect(ticketFieldWrite('ticket.update', { id: ID, description: emoji })?.fields.description).toBe(
      'a'.repeat(4999),
    );
  });

  it('ignores mutations that write no ticket text', () => {
    expect(ticketFieldWrite('ticket.setStatus', { id: ID, from: 'open', to: 'done' })).toBeUndefined();
    expect(ticketFieldWrite('part.add', { id: ID, ticketId: ID, name: 'Seal', quantity: 1 })).toBeUndefined();
  });
});

describe('lostEdits', () => {
  const stored = (data: Row): StoredRow => ({ entity: 'ticket', id: 't1', siteId: 's1', data });
  const writes = [
    { ticket: 't1', fields: { title: 'Pump', description: 'Leaks' } },
    { ticket: 't1', fields: { title: 'Main pump' } },
    { ticket: 't1', fields: { description: 'Leaks badly' } },
  ];

  it('accepts a ticket whose fields hold the last write of each field', () => {
    expect(lostEdits([stored({ id: 't1', title: 'Main pump', description: 'Leaks badly' })], writes)).toEqual([]);
  });

  it('reports a field that an edit of the other field overwrote', () => {
    expect(lostEdits([stored({ id: 't1', title: 'Main pump', description: '' })], writes)).toEqual([
      'ticket/t1.description: stored "", last written "Leaks badly"',
    ]);
  });

  it('reports a field that holds an older write', () => {
    expect(lostEdits([stored({ id: 't1', title: 'Pump', description: 'Leaks badly' })], writes)).toEqual([
      'ticket/t1.title: stored "Pump", last written "Main pump"',
    ]);
  });

  it('skips tickets with a write of unknown order, deleted tickets and tickets nobody wrote', () => {
    const wrong = stored({ id: 't1', title: 'x', description: 'y' });
    expect(lostEdits([wrong], writes, new Set(['t1']))).toEqual([]);
    expect(lostEdits([], writes)).toEqual([]);
    expect(lostEdits([wrong], [])).toEqual([]);
  });
});
