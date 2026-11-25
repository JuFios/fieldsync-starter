/**
 * Known-defect tests.
 *
 * A known-defect test asserts the *correct* behaviour of a defect that is already reproduced but
 * fixed in a later change. Unlike a bare `test.failing`, which passes on any error, it counts as
 * "expectedly red" only when the body fails with an assertion error:
 *
 * - assertion error            -> the test passes (the defect is still there);
 * - any other error            -> the test fails (a broken harness must not look like a reproduced defect);
 * - the body passes            -> the test fails with "defect F-NN appears fixed - flip it".
 *
 * The defect id, owner and reason are encoded in the test title so that the known-defect reporter
 * can list them without sharing state between Jest workers.
 */

export interface KnownDefect {
  /** Found-issues id from the README, e.g. `F-07`. */
  id: string;
  /** The change that owns the fix, e.g. `PR6`. */
  owner: string;
  /** One line: what is wrong. */
  reason: string;
}

const ID = /^F-\d{2,}$/;
const OWNER = /^PR\d+$/;
const TITLE = /^\[known defect (F-\d{2,}) -> (PR\d+)\] /;

export class KnownDefectFixedError extends Error {
  constructor(readonly defect: KnownDefect) {
    super(
      `Defect ${defect.id} appears fixed - flip it: replace knownDefect(...) with it(...) ` +
        `and update its Found issues entry in the README.`,
    );
    this.name = 'KnownDefectFixedError';
  }
}

/** True for failures raised by `expect(...)` (Jest) and by `node:assert`. */
export function isAssertionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('matcherResult' in err) return true;
  return (err as { code?: unknown }).code === 'ERR_ASSERTION';
}

export function validateDefect(defect: KnownDefect): void {
  if (!ID.test(defect.id)) throw new Error(`Known defect id must look like F-07, got "${defect.id}"`);
  if (!OWNER.test(defect.owner)) throw new Error(`Known defect owner must look like PR6, got "${defect.owner}"`);
  if (defect.reason.trim().length === 0) throw new Error(`Known defect ${defect.id} needs a reason`);
}

/** Runs a known-defect body and applies the rules above. Exported for the helper's own tests. */
export async function runKnownDefect(defect: KnownDefect, body: () => unknown): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (isAssertionError(err)) return;
    throw err;
  }
  throw new KnownDefectFixedError(defect);
}

export function knownDefectTitle(defect: KnownDefect, name: string): string {
  return `[known defect ${defect.id} -> ${defect.owner}] ${name}`;
}

/** Parses a title produced by {@link knownDefectTitle}; returns undefined for ordinary tests. */
export function parseKnownDefectTitle(title: string): { id: string; owner: string } | undefined {
  const match = TITLE.exec(title);
  return match ? { id: match[1], owner: match[2] } : undefined;
}

/**
 * Declares a known-defect test. Do not call `expect.assertions` inside the body: Jest checks it after
 * the body returns, outside the assertion-error filter.
 */
export function knownDefect(defect: KnownDefect, name: string, body: () => unknown, timeout?: number): void {
  validateDefect(defect);
  test(knownDefectTitle(defect, name), () => runKnownDefect(defect, body), timeout);
}
