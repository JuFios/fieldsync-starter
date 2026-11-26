import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MutationRejected, rejectWith, type ReceivedMutation } from '@fieldsync/sync-core';
import { Clock } from '../../src/clock';
import { Db } from '../../src/db';
import { PushService } from '../../src/push.service';
import { appendToLog, applyMutation, type LogEntry } from '../../src/server-tx';
import { StreamService } from '../../src/stream.service';
import { mockDb, result, type MockDb } from './support';

// The mutation itself is applied by server-tx (tested on Postgres); here only the push loop matters.
jest.mock('../../src/server-tx', () => ({ applyMutation: jest.fn(), appendToLog: jest.fn() }));
const apply = jest.mocked(applyMutation);
const append = jest.mocked(appendToLog);

const NOW = new Date('2026-11-26T12:00:00.000Z');
const USER = { id: 'user-1', role: 'technician' as const };
const CLIENT = '0b7f3c1e-2a4d-4e5f-8a6b-7c8d9e0f1a2b';
const NORTH = 'site-north';
const ENTRY: LogEntry = { siteId: NORTH, entity: 'ticket', id: 't1', op: 'put', data: { title: 'T' } };

const mutation = (id: number): ReceivedMutation => ({ id, name: 'ticket.setStatus', args: { id: 't1' } });

/**
 * The clients and mutation_results tables as the SQL of the push sees them: answers the statements
 * by their text and keeps the state the transaction writes.
 */
class FakeTables {
  last: number | undefined;
  readonly results = new Map<
    number,
    { status: string; code: string | null; message: string | null; details: string | null }
  >();
  /** Statements in order, without their parameters, to check the locking order. */
  readonly statements: string[] = [];

  answer(sql: string, params: unknown[] = []) {
    const kind = sql.trim().split(/\s+/).slice(0, 3).join(' ');
    this.statements.push(kind);
    if (sql.includes('INSERT INTO clients')) {
      this.last ??= 0;
      return result([], 1);
    }
    if (sql.includes('FROM clients') && sql.includes('FOR UPDATE')) {
      return result([{ last_mutation_id: String(this.last ?? 0) }]);
    }
    if (sql.includes('FROM clients')) {
      return result(this.last === undefined ? [] : [{ last_mutation_id: String(this.last) }]);
    }
    if (sql.includes('INSERT INTO mutation_results')) {
      const [, id, status, code, message, details] = params as [
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
      ];
      this.results.set(id, { status, code, message, details });
      return result([], 1);
    }
    if (sql.includes('FROM mutation_results')) {
      const stored = this.results.get(params[1] as number);
      return result(
        stored
          ? [{ ...stored, details: stored.details === null ? null : (JSON.parse(stored.details) as unknown) }]
          : [],
      );
    }
    if (sql.includes('UPDATE clients')) {
      this.last = params[1] as number;
      return result([], 1);
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

describe('PushService', () => {
  let push: PushService;
  let db: MockDb;
  let tables: FakeTables;
  let notify: jest.Mock;

  beforeEach(async () => {
    db = mockDb();
    tables = new FakeTables();
    db.query.mockImplementation((sql, params) => Promise.resolve(tables.answer(sql, params)));
    db.inTx.query.mockImplementation((sql, params) => Promise.resolve(tables.answer(sql, params)));
    apply.mockReset().mockResolvedValue([ENTRY]);
    append.mockReset().mockImplementation(() => {
      tables.statements.push('append to log');
      return Promise.resolve();
    });
    notify = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: Db, useValue: db },
        { provide: StreamService, useValue: { notify } },
        { provide: Clock, useValue: { now: () => NOW } },
      ],
    }).compile();
    push = moduleRef.get(PushService);
  });

  describe('lastMutationId', () => {
    it('is 0 for an unknown client', async () => {
      await expect(push.lastMutationId(CLIENT)).resolves.toBe(0);
    });

    it('converts the stored bigint to a number', async () => {
      tables.last = 42;
      await expect(push.lastMutationId(CLIENT)).resolves.toBe(42);
    });
  });

  describe('push', () => {
    it('applies new mutations in order, each in its own transaction, and notifies their sites', async () => {
      const res = await push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2)] });

      expect(res).toEqual({
        results: [
          { id: 1, status: 'applied' },
          { id: 2, status: 'applied' },
        ],
        lastMutationId: 2,
      });
      expect(apply.mock.calls.map(([, user, m, at]) => [user, m.id, at])).toEqual([
        [USER, 1, NOW],
        [USER, 2, NOW],
      ]);
      expect(db.tx).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls).toEqual([[[NORTH]], [[NORTH]]]);
    });

    it('locks the client first, runs the mutator, records the outcome and appends to the log last', async () => {
      apply.mockImplementation(() => {
        tables.statements.push('mutator');
        return Promise.resolve([ENTRY]);
      });
      await push.push(USER, { clientId: CLIENT, mutations: [mutation(1)] });
      expect(tables.statements).toEqual([
        'INSERT INTO clients',
        'SELECT last_mutation_id FROM',
        'mutator',
        'INSERT INTO mutation_results',
        'UPDATE clients SET',
        'append to log',
        'SELECT last_mutation_id FROM',
      ]);
      expect(append).toHaveBeenCalledWith(db.inTx, [ENTRY], NOW);
      expect(db.inTx.savepoint).toHaveBeenCalledTimes(1);
    });

    it('answers copies of applied mutations as duplicates without applying them again', async () => {
      await push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2)] });
      apply.mockClear();
      const res = await push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2), mutation(3)] });
      expect(res.results).toEqual([
        { id: 1, status: 'duplicate' },
        { id: 2, status: 'duplicate' },
        { id: 3, status: 'applied' },
      ]);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(res.lastMutationId).toBe(3);
    });

    it('answers a rejected mutation with its reason, records it as handled and goes on', async () => {
      apply
        .mockResolvedValueOnce([ENTRY])
        .mockRejectedValueOnce(
          rejectWith('STATUS_CONFLICT', 'Status is now "done"', { current: 'done', allowed: ['open'] }),
        )
        .mockResolvedValueOnce([ENTRY]);
      const res = await push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2), mutation(3)] });
      const rejection = {
        id: 2,
        status: 'rejected',
        code: 'STATUS_CONFLICT',
        message: 'Status is now "done"',
        details: { current: 'done', allowed: ['open'] },
      };
      expect(res).toEqual({
        results: [{ id: 1, status: 'applied' }, rejection, { id: 3, status: 'applied' }],
        lastMutationId: 3,
      });
      expect(notify.mock.calls).toEqual([[[NORTH]], [[NORTH]]]);

      // A copy of the rejected mutation gets the same rejection back, without running the mutator.
      apply.mockClear();
      const again = await push.push(USER, { clientId: CLIENT, mutations: [mutation(2)] });
      expect(again.results).toEqual([rejection]);
      expect(apply).not.toHaveBeenCalled();
    });

    it('leaves out details a rejection does not have, also in the answer to a copy', async () => {
      apply.mockRejectedValueOnce(new MutationRejected('NOT_FOUND', 'Ticket no longer exists'));
      const first = await push.push(USER, { clientId: CLIENT, mutations: [mutation(1)] });
      const copy = await push.push(USER, { clientId: CLIENT, mutations: [mutation(1)] });
      const rejection = { id: 1, status: 'rejected', code: 'NOT_FOUND', message: 'Ticket no longer exists' };
      expect([first.results, copy.results]).toEqual([[rejection], [rejection]]);
    });

    it('answers a copy whose result has expired as a duplicate', async () => {
      tables.last = 5;
      const res = await push.push(USER, { clientId: CLIENT, mutations: [mutation(3)] });
      expect(res.results).toEqual([{ id: 3, status: 'duplicate' }]);
    });

    it('rejects a gap in the mutation ids with 400 and the expected id', async () => {
      tables.last = 1;
      const run = push.push(USER, { clientId: CLIENT, mutations: [mutation(3)] });
      await expect(run).rejects.toThrow(BadRequestException);
      await expect(run).rejects.toThrow('Out-of-order mutation 3, expected 2');
      expect(apply).not.toHaveBeenCalled();
    });

    it('answers an empty batch with the stored last mutation id', async () => {
      tables.last = 5;
      await expect(push.push(USER, { clientId: CLIENT, mutations: [] })).resolves.toEqual({
        results: [],
        lastMutationId: 5,
      });
    });

    it('stops at a mutation whose transaction fails, keeping the earlier ones, and notifies nobody for it', async () => {
      apply.mockResolvedValueOnce([ENTRY]).mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(
        push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2), mutation(3)] }),
      ).rejects.toThrow('deadlock detected');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(2);
    });
  });
});
