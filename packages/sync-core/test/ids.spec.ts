import {
  asClientId,
  asLastMutationId,
  asMutationId,
  asVersion,
  isClientId,
  isLastMutationId,
  isMutationId,
  type ClientId,
  type LastMutationId,
  type Mutation,
  type MutationId,
  type PullResponse,
  type SyncMeta,
  type Transport,
  type Version,
} from '../src';

const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('MutationId', () => {
  it.each([1, 2, Number.MAX_SAFE_INTEGER])('takes %p', (n) => {
    expect(asMutationId(n)).toBe(n);
    expect(isMutationId(n)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %p', (n) => {
    expect(() => asMutationId(n)).toThrow(RangeError);
    expect(isMutationId(n)).toBe(false);
  });

  it.each(['1', null, undefined, {}])('does not take the value %p for one', (value) => {
    expect(isMutationId(value)).toBe(false);
  });

  it('as the last handled id may also be 0, which means none', () => {
    expect(asLastMutationId(0)).toBe(0);
    expect(asLastMutationId(7)).toBe(7);
    expect([0, 7, -1, '0'].map(isLastMutationId)).toEqual([true, true, false, false]);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])('refuses %p as the last handled id', (n) => {
    expect(() => asLastMutationId(n)).toThrow(RangeError);
  });
});

describe('ClientId', () => {
  it('takes a UUID in lower case', () => {
    expect(asClientId(UUID)).toBe(UUID);
    expect(isClientId(UUID)).toBe(true);
  });

  it.each([
    ['upper case', UUID.toUpperCase()],
    ['mixed case', `A${UUID.slice(1)}`],
    ['no hyphens', UUID.replaceAll('-', '')],
    ['too short', UUID.slice(1)],
    ['trailing text', `${UUID}0`],
    ['a letter outside hex', `g${UUID.slice(1)}`],
    ['braces', `{${UUID}}`],
    ['surrounding space', ` ${UUID}`],
    ['a trailing newline', `${UUID}\n`],
    ['empty', ''],
  ])('refuses %s', (_what, value) => {
    expect(() => asClientId(value)).toThrow(RangeError);
    expect(isClientId(value)).toBe(false);
  });

  it.each([7, null, undefined, {}])('does not take the value %p for one', (value) => {
    expect(isClientId(value)).toBe(false);
  });
});

/**
 * Compile-time checks: `npm run typecheck` (and ts-jest) fails if a line under `@ts-expect-error`
 * compiles, that is if a brand stops telling the ids apart. Nothing here has to run.
 */
describe('the id types', () => {
  it('do not stand in for one another, or for a plain number or string', () => {
    const check = (
      version: Version,
      mutationId: MutationId,
      last: LastMutationId,
      clientId: ClientId,
      meta: SyncMeta,
      page: PullResponse,
      transport: Required<Transport>,
    ) => {
      // @ts-expect-error a version is not a mutation id
      const a: MutationId = version;
      // @ts-expect-error a mutation id is not a version
      const b: Version = mutationId;
      // @ts-expect-error nor is the last handled id, which may be a mutation id
      const c: Version = last;
      // @ts-expect-error a plain number is not a mutation id
      const d: MutationId = Number('1');
      // @ts-expect-error the last handled id may be 0, which is no mutation id
      const e: MutationId = last;
      // @ts-expect-error a mutation's id cannot be a version
      const f: Mutation = { id: version, name: 'ticket.delete', args: {} };
      // @ts-expect-error the next id to give out cannot come from the cursor
      const g: SyncMeta = { ...meta, nextMutationId: version };
      // @ts-expect-error the last handled id of a pull is not its cursor
      const h: Version = page.lastMutationId;
      // @ts-expect-error a plain string is not a client id
      const i: ClientId = String(clientId);
      // @ts-expect-error a client is retired by its id, not by any string
      const j = () => transport.retire('c1');
      // @ts-expect-error a pull takes a client id, not any string
      const k = () => transport.pull(0, 'c1');
      // A mutation id is a last handled id, and every id is still the number or string on the wire.
      const l: LastMutationId = mutationId;
      const m: [number, number, string] = [mutationId, version, clientId];
      return [a, b, c, d, e, f, g, h, i, j, k, l, m];
    };
    expect(check).toBeInstanceOf(Function);
    // The wire format is unchanged: a branded value serialises as the value itself.
    expect(JSON.stringify([asMutationId(3), asVersion(4), asClientId(UUID)])).toBe(`[3,4,"${UUID}"]`);
  });
});
