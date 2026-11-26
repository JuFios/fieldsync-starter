import { parseSeed, Random } from '../src/random';

describe('Random', () => {
  it('matches the reference xoshiro128** output for the state [1, 2, 3, 4]', () => {
    // Printed by the reference C implementation (Blackman and Vigna, xoshiro128starstar.c).
    const random = Random.fromState([1, 2, 3, 4]);
    const values = Array.from({ length: 8 }, () => random.nextUint32());
    expect(values).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849]);
  });

  it('matches the reference splitmix32 output', () => {
    expect(Random.splitmix32Sequence(0, 6)).toEqual([
      1684164658, 3653269916, 2939563536, 2141751570, 3295091513, 4057132772,
    ]);
    expect(Random.splitmix32Sequence(0xdeadbeef, 6)).toEqual([
      46217145, 304148291, 1711218402, 2692075039, 4098511199, 697799442,
    ]);
  });

  it('repeats the same sequence for the same seed and stream', () => {
    const a = new Random(42, '/x');
    const b = new Random(42, '/x');
    expect(Array.from({ length: 100 }, () => a.nextUint32())).toEqual(
      Array.from({ length: 100 }, () => b.nextUint32()),
    );
  });

  it('gives different sequences to different seeds and streams', () => {
    const first = (r: Random) => Array.from({ length: 4 }, () => r.nextUint32());
    expect(first(new Random(1))).not.toEqual(first(new Random(2)));
    expect(first(new Random(1, '/a'))).not.toEqual(first(new Random(1, '/b')));
  });

  it('forks streams that do not depend on how much the parent consumed', () => {
    const fresh = new Random(7);
    const used = new Random(7);
    for (let i = 0; i < 1000; i += 1) used.nextUint32();
    expect(used.fork('network').nextUint32()).toBe(fresh.fork('network').nextUint32());
    expect(fresh.fork('network').fork('c1').stream).toBe('/network/c1');
  });

  it('accepts only unsigned 32-bit seeds', () => {
    expect(() => new Random(-1)).toThrow(RangeError);
    expect(() => new Random(2 ** 32)).toThrow(RangeError);
    expect(() => new Random(1.5)).toThrow(RangeError);
    expect(() => new Random(2 ** 32 - 1)).not.toThrow();
  });

  it('draws integers within the bounds and reaches both ends', () => {
    const random = new Random(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const value = random.int(-2, 2);
      expect(value).toBeGreaterThanOrEqual(-2);
      expect(value).toBeLessThanOrEqual(2);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([-1, -2, 0, 1, 2]);
    expect(() => random.int(3, 2)).toThrow(RangeError);
  });

  it('draws roughly uniform integers', () => {
    const random = new Random(11);
    const counts = new Map<number, number>();
    const draws = 60_000;
    for (let i = 0; i < draws; i += 1) {
      const value = random.int(0, 5);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    // Each bucket expects 10 000; 5 standard deviations is about +-456.
    expect(counts.size).toBe(6);
    for (const count of counts.values()) expect(Math.abs(count - draws / 6)).toBeLessThan(500);
  });

  it('chooses by weight and never chooses a zero weight', () => {
    const random = new Random(5);
    const counts = { a: 0, b: 0, never: 0 };
    for (let i = 0; i < 30_000; i += 1) counts[random.weighted({ a: 1, b: 3, never: 0 })] += 1;
    expect(counts.never).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(2.7);
    expect(counts.b / counts.a).toBeLessThan(3.3);
    expect(() => random.weighted({ a: 0 })).toThrow(RangeError);
  });

  it('honours the extremes of chance()', () => {
    const random = new Random(9);
    for (let i = 0; i < 100; i += 1) {
      expect(random.chance(0)).toBe(false);
      expect(random.chance(1)).toBe(true);
    }
    expect(() => random.chance(1.5)).toThrow(RangeError);
  });

  it('generates version-4 UUIDs the server accepts', () => {
    const random = new Random(13);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = random.uuid();
      expect(id).toMatch(uuid);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });

  it('generates hex strings of the requested length', () => {
    expect(new Random(1).hex(24)).toMatch(/^[0-9a-f]{48}$/);
  });

  it('parses decimal and hexadecimal seeds', () => {
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed('0xff')).toBe(255);
    expect(parseSeed('4294967295')).toBe(4294967295);
    for (const bad of ['-1', '4294967296', '1.5', 'abc', '']) expect(() => parseSeed(bad)).toThrow(RangeError);
  });
});
