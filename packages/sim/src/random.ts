/**
 * Seeded randomness for the simulation.
 *
 * The generator is xoshiro128** 1.1 (Blackman and Vigna), seeded through splitmix32, both written
 * with 32-bit integer arithmetic (`Math.imul`, `>>> 0`) and checked against the reference C code in
 * the tests. Every consumer takes its own named stream with {@link Random.fork}: a stream depends
 * only on the root seed and its name, never on how much another stream has consumed, so changing
 * how user actions are generated does not shift the network's fault decisions of the same seed.
 */

/** splitmix32 step (the variant with the 0x21f0aaad / 0x735a2d97 finaliser). */
function splitmix32(state: number): { state: number; value: number } {
  const next = (state + 0x9e3779b9) | 0;
  let t = next ^ (next >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return { state: next, value: t >>> 0 };
}

/** FNV-1a over the UTF-16 code units of `text`. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

const TWO_POW_32 = 0x1_0000_0000;

export class Random {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /**
   * @param seed   any unsigned 32-bit integer
   * @param stream the stream's name; {@link fork} builds it as a path such as `/network/c1`
   */
  constructor(
    readonly seed: number,
    readonly stream = '',
  ) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= TWO_POW_32) {
      throw new RangeError(`seed must be an integer from 0 to 2^32 - 1, got ${seed}`);
    }
    let sm = (seed ^ fnv1a(stream)) | 0;
    const words: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const step = splitmix32(sm);
      sm = step.state;
      words.push(step.value);
    }
    [this.s0, this.s1, this.s2, this.s3] = words as [number, number, number, number];
    // xoshiro must not start from the all-zero state; splitmix32 makes that practically impossible,
    // but the generator would be stuck at zero forever, so guard it explicitly.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** A generator with an explicit xoshiro128** state; for checking the algorithm against reference vectors. */
  static fromState(state: readonly [number, number, number, number]): Random {
    const random = new Random(0);
    [random.s0, random.s1, random.s2, random.s3] = state.map((w) => w >>> 0) as [number, number, number, number];
    return random;
  }

  /** The splitmix32 sequence from `state`; exported for the reference-vector tests. */
  static splitmix32Sequence(state: number, count: number): number[] {
    const out: number[] = [];
    let sm = state | 0;
    for (let i = 0; i < count; i += 1) {
      const step = splitmix32(sm);
      sm = step.state;
      out.push(step.value);
    }
    return out;
  }

  /** An independent stream named `label` below this one, determined by the root seed and the path only. */
  fork(label: string): Random {
    return new Random(this.seed, `${this.stream}/${label}`);
  }

  /** The next unsigned 32-bit value (xoshiro128**). */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** A float in [0, 1) with 32 bits of randomness. */
  float(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  /** An integer in [min, max], without modulo bias (rejection sampling). */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`int(${min}, ${max}): bounds must be integers with min <= max`);
    }
    const span = max - min + 1;
    if (span > TWO_POW_32) throw new RangeError(`int(${min}, ${max}): range is wider than 2^32`);
    const limit = TWO_POW_32 - (TWO_POW_32 % span);
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) return min + (value % span);
    }
  }

  /** True with probability `p` (0 never draws true, 1 always does). */
  chance(p: number): boolean {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`chance(${p}): p must be in [0, 1]`);
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /**
   * A key chosen with probability proportional to its weight. Keys are visited in the object's own
   * order, which is deterministic for string keys. Zero weights are never chosen.
   */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as Array<[K, number]>;
    let total = 0;
    for (const [key, weight] of entries) {
      if (!(weight >= 0) || !Number.isFinite(weight)) throw new RangeError(`weight of ${key} must be >= 0`);
      total += weight;
    }
    if (total === 0) throw new RangeError('weighted() needs at least one positive weight');
    let point = this.float() * total;
    for (const [key, weight] of entries) {
      if (weight === 0) continue;
      if (point < weight) return key;
      point -= weight;
    }
    // Floating-point rounding can leave `point` a hair above the last weight.
    return entries.filter(([, w]) => w > 0).at(-1)?.[0] as K;
  }

  /** A version-4 UUID (as the server's UUID check expects: version nibble 4, variant 10xx). */
  uuid(): string {
    const hex = (word: number) => word.toString(16).padStart(8, '0');
    const a = hex(this.nextUint32());
    const b = hex(this.nextUint32());
    const c = hex(this.nextUint32());
    const d = hex(this.nextUint32());
    const variant = ((parseInt(c[0] as string, 16) & 0x3) | 0x8).toString(16);
    return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-${variant}${c.slice(1, 4)}-${c.slice(4, 8)}${d}`;
  }

  /** `bytes` random bytes as lowercase hex; for tokens. */
  hex(bytes: number): string {
    let out = '';
    while (out.length < bytes * 2) out += this.nextUint32().toString(16).padStart(8, '0');
    return out.slice(0, bytes * 2);
  }
}

/** Parses a seed given as a decimal or 0x-prefixed hexadecimal string. */
export function parseSeed(text: string): number {
  const value = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text.slice(2), 16) : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < 0 || value >= TWO_POW_32) {
    throw new RangeError(`"${text}" is not a seed (an integer from 0 to 4294967295)`);
  }
  return value;
}
