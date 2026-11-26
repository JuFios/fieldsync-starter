import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Mutation } from '@fieldsync/sync-core';
import { Clock } from '../../src/clock';
import { Db } from '../../src/db';
import { PushService } from '../../src/push.service';
import { applyMutation } from '../../src/server-tx';
import { StreamService } from '../../src/stream.service';
import { mockDb, result, type MockDb } from './support';

// The mutation itself is applied by server-tx (tested on Postgres); here only the push loop matters.
jest.mock('../../src/server-tx', () => ({ applyMutation: jest.fn() }));
const apply = jest.mocked(applyMutation);

const NOW = new Date('2026-11-26T12:00:00.000Z');
const USER = { id: 'user-1', role: 'technician' as const };
const CLIENT = 'client-1';
const NORTH = 'site-north';

const mutation = (id: number): Mutation => ({ id, name: 'ticket.setStatus', args: { id: 't1', status: 'done' } });

describe('PushService', () => {
  let push: PushService;
  let db: MockDb;
  let notify: jest.Mock;
  /** last_mutation_id as the clients table holds it; the mocked transaction advances it. */
  let stored: number | undefined;

  beforeEach(async () => {
    db = mockDb();
    stored = undefined;
    db.query.mockImplementation(() =>
      Promise.resolve(result(stored === undefined ? [] : [{ last_mutation_id: String(stored) }])),
    );
    db.inTx.query.mockImplementation((_sql, params) => {
      stored = params?.[2] as number;
      return Promise.resolve(result([], 1));
    });
    apply.mockReset().mockResolvedValue([NORTH]);
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
      expect(db.query).toHaveBeenCalledWith('SELECT last_mutation_id FROM clients WHERE client_id = $1', [CLIENT]);
    });

    it('converts the stored bigint to a number', async () => {
      stored = 42;
      await expect(push.lastMutationId(CLIENT)).resolves.toBe(42);
    });
  });

  describe('push', () => {
    it('applies new mutations in order, each in a transaction that records the client, and notifies their sites', async () => {
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
      expect(db.inTx.query.mock.calls.map(([, params]) => params)).toEqual([
        [CLIENT, USER.id, 1],
        [CLIENT, USER.id, 2],
      ]);
      expect(notify.mock.calls).toEqual([[[NORTH]], [[NORTH]]]);
    });

    it('reports mutations the client already sent as duplicates without applying them again', async () => {
      stored = 2;
      const res = await push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2), mutation(3)] });
      expect(res.results).toEqual([
        { id: 1, status: 'duplicate' },
        { id: 2, status: 'duplicate' },
        { id: 3, status: 'applied' },
      ]);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(res.lastMutationId).toBe(3);
    });

    it('rejects a gap in the mutation ids with 400 and the expected id', async () => {
      stored = 1;
      const run = push.push(USER, { clientId: CLIENT, mutations: [mutation(3)] });
      await expect(run).rejects.toThrow(BadRequestException);
      await expect(run).rejects.toThrow('Out-of-order mutation 3, expected 2');
      expect(apply).not.toHaveBeenCalled();
    });

    it('answers an empty batch with the stored last mutation id', async () => {
      stored = 5;
      await expect(push.push(USER, { clientId: CLIENT, mutations: [] })).resolves.toEqual({
        results: [],
        lastMutationId: 5,
      });
    });

    it('stops at a mutation whose transaction fails, keeping the earlier ones, and notifies nobody for it', async () => {
      apply.mockResolvedValueOnce([NORTH]).mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(
        push.push(USER, { clientId: CLIENT, mutations: [mutation(1), mutation(2), mutation(3)] }),
      ).rejects.toThrow('deadlock detected');
      expect(stored).toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(2);
    });
  });
});
