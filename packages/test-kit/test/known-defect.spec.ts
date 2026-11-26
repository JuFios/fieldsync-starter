import { strict as assert } from 'node:assert';
import {
  KnownDefectFixedError,
  PreconditionError,
  isAssertionError,
  knownDefectTitle,
  parseKnownDefectTitle,
  precondition,
  runKnownDefect,
  validateDefect,
  type KnownDefect,
} from '../src/known-defect';

const DEFECT: KnownDefect = { id: 'F-07', owner: 'access-control', reason: 'pull ignores the site filter' };

describe('runKnownDefect', () => {
  it('passes when the body fails a Jest assertion', async () => {
    await expect(runKnownDefect(DEFECT, () => expect(1).toBe(2))).resolves.toBeUndefined();
  });

  it('passes when an async body fails a Jest assertion after awaiting', async () => {
    await expect(
      runKnownDefect(DEFECT, async () => {
        await Promise.resolve();
        await expect(Promise.resolve(1)).resolves.toBe(2);
      }),
    ).resolves.toBeUndefined();
  });

  it('passes when the body fails a node:assert assertion', async () => {
    await expect(runKnownDefect(DEFECT, () => assert.equal(1, 2))).resolves.toBeUndefined();
  });

  it('fails with the original error when the body throws something other than an assertion', async () => {
    const boom = new TypeError('harness is broken');
    await expect(runKnownDefect(DEFECT, () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('fails when the body throws a non-error value', async () => {
    await expect(
      runKnownDefect(DEFECT, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test is a non-Error throw
        throw 'not an error';
      }),
    ).rejects.toBe('not an error');
  });

  it('fails when a precondition of the scenario does not hold, even before the defect assertion', async () => {
    const run = runKnownDefect(DEFECT, () => {
      precondition(false, 'push answered 500 while creating the fixture');
      expect(1).toBe(2);
    });
    await expect(run).rejects.toBeInstanceOf(PreconditionError);
    await expect(run).rejects.toThrow('Precondition failed: push answered 500 while creating the fixture');
  });

  it('fails with "flip it" when the body passes', async () => {
    const run = runKnownDefect(DEFECT, () => expect(1).toBe(1));
    await expect(run).rejects.toBeInstanceOf(KnownDefectFixedError);
    await expect(run).rejects.toThrow('Defect F-07 appears fixed - flip it');
  });
});

describe('isAssertionError', () => {
  it('recognises Jest and node:assert failures only', () => {
    let jestError: unknown;
    try {
      expect(true).toBe(false);
    } catch (err) {
      jestError = err;
    }
    let nodeError: unknown;
    try {
      assert.ok(false);
    } catch (err) {
      nodeError = err;
    }
    expect(isAssertionError(jestError)).toBe(true);
    expect(isAssertionError(nodeError)).toBe(true);
    expect(isAssertionError(new Error('x'))).toBe(false);
    expect(isAssertionError(null)).toBe(false);
    expect(isAssertionError('x')).toBe(false);
  });
});

describe('known defect metadata', () => {
  it('round-trips the id and owner through the test title', () => {
    const title = knownDefectTitle(DEFECT, 'returns only accessible sites');
    expect(title).toBe('[known defect F-07 -> access-control] returns only accessible sites');
    expect(parseKnownDefectTitle(title)).toEqual({ id: 'F-07', owner: 'access-control' });
    expect(parseKnownDefectTitle('returns only accessible sites')).toBeUndefined();
  });

  it('rejects malformed ids, owners and empty reasons', () => {
    expect(() => validateDefect({ ...DEFECT, id: '7' })).toThrow('F-07');
    expect(() => validateDefect({ ...DEFECT, owner: 'PR6' })).toThrow('access-control');
    expect(() => validateDefect({ ...DEFECT, reason: ' ' })).toThrow('needs a reason');
    expect(() => validateDefect(DEFECT)).not.toThrow();
  });
});
