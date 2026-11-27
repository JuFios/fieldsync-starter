import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * A client retries a push whose answer it did not get, and a flaky network can deliver the same
 * request several times at once. However many copies arrive, and however they interleave, a
 * mutation is applied once, and every copy is answered with what happened to it.
 */
describeWithDb('parallel duplicates of one mutation', () => {
  const ctx = useIntegration();
  const COPIES = 50;
  const ROUNDS = 100;

  const push = (user: TestUser, clientId: string, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);

  async function partWithQuantity(user: TestUser, site: string, quantity: number): Promise<string> {
    const ticket = randomUUID();
    const part = randomUUID();
    const res = await push(user, randomUUID(), [
      {
        id: asMutationId(1),
        name: 'ticket.create',
        args: { id: ticket, siteId: site, title: 'Pump', description: '' },
      },
      {
        id: asMutationId(2),
        name: 'part.add',
        args: { id: part, ticketId: ticket, siteId: site, name: 'Seal', quantity },
      },
    ]);
    precondition(res.status === 201, `setup push answered ${res.status}`);
    return part;
  }

  async function quantityOf(part: string): Promise<number> {
    const { rows } = await ctx.db.query<{ q: number }>(
      `SELECT (data->>'quantity')::int AS q FROM entities WHERE entity = 'part' AND id = $1`,
      [part],
    );
    return rows[0].q;
  }

  it(`applies an adjustment pushed ${COPIES} times at once exactly once, in each of ${ROUNDS} rounds`, async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    for (let round = 1; round <= ROUNDS; round += 1) {
      const part = await partWithQuantity(tech, site, 1);
      const clientId = randomUUID();
      const adjust: Mutation = { id: asMutationId(1), name: 'part.adjust', args: { id: part, siteId: site, delta: 1 } };
      const answers = await Promise.all(Array.from({ length: COPIES }, () => push(tech, clientId, [adjust])));
      const outcome = {
        round,
        statuses: [...new Set(answers.map((a) => a.status))],
        applied: answers.filter((a) => a.body.results?.[0]?.status === 'applied').length,
        quantity: await quantityOf(part),
      };
      expect(outcome).toEqual({ round, statuses: [201], applied: 1, quantity: 2 });
    }
  }, 300_000);

  it('answers every copy of a rejected mutation with the same rejection, the first one included', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const part = await partWithQuantity(tech, site, 1);
    const clientId = randomUUID();
    const tooMuch: Mutation = { id: asMutationId(1), name: 'part.adjust', args: { id: part, siteId: site, delta: -5 } };
    const answers = await Promise.all(Array.from({ length: COPIES }, () => push(tech, clientId, [tooMuch])));
    const rejection = {
      status: 201,
      results: [
        {
          id: 1,
          status: 'rejected',
          code: 'NEGATIVE_QUANTITY',
          message: 'Quantity cannot go below zero',
          details: { quantity: 1, delta: -5 },
        },
      ],
    };
    expect(answers.map((a) => ({ status: a.status, results: a.body.results }))).toEqual(
      Array.from({ length: COPIES }, () => rejection),
    );
    expect(await quantityOf(part)).toBe(1);
  });

  it('answers a retried push of a rejected mutation with the rejection again', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const part = await partWithQuantity(tech, site, 1);
    const clientId = randomUUID();
    const tooMuch: Mutation = { id: asMutationId(1), name: 'part.adjust', args: { id: part, siteId: site, delta: -5 } };
    const first = await push(tech, clientId, [tooMuch]);
    const retry = await push(tech, clientId, [tooMuch]);
    expect(retry.body).toEqual(first.body);
  });

  it('applies overlapping batches of one client once each and in order', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const part = await partWithQuantity(tech, site, 1);
    const clientId = randomUUID();
    const adjust = (id: number): Mutation => ({
      id: asMutationId(id),
      name: 'part.adjust',
      args: { id: part, siteId: site, delta: id },
    });
    // A retry that adds the next mutations races the original request.
    const answers = await Promise.all([
      push(tech, clientId, [adjust(1)]),
      push(tech, clientId, [adjust(1), adjust(2)]),
      push(tech, clientId, [adjust(1), adjust(2), adjust(3)]),
      push(tech, clientId, [adjust(1)]),
    ]);
    expect(answers.map((a) => a.status)).toEqual([201, 201, 201, 201]);
    expect(await quantityOf(part)).toBe(1 + 1 + 2 + 3);
  });
});
