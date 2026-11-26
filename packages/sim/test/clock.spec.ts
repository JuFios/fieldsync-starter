import { VirtualClock } from '../src/clock';

const settled = () => Promise.resolve();

describe('VirtualClock', () => {
  it('moves only when advanced', async () => {
    const clock = new VirtualClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.advance(250, settled);
    expect(clock.now()).toBe(1_250);
  });

  it('fires due timers in due order, ties in creation order, at their due time', async () => {
    const clock = new VirtualClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => fired.push(`c@${clock.now()}`), 20);
    clock.setTimeout(() => fired.push('late'), 31);
    expect(await clock.advance(30, settled)).toBe(3);
    expect(fired).toEqual(['a@10', 'b@20', 'c@20']);
    expect(clock.now()).toBe(30);
    expect(clock.pendingTimers).toBe(1);
    expect(clock.nextDue()).toBe(31);
  });

  it('fires a timer set by another timer if it falls due within the same advance', async () => {
    const clock = new VirtualClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now());
      clock.setTimeout(() => fired.push(clock.now()), 5);
    }, 5);
    await clock.advance(10, settled);
    expect(fired).toEqual([5, 10]);
  });

  it('does not fire a cleared timer', async () => {
    const clock = new VirtualClock(0);
    const fired: string[] = [];
    const handle = clock.setTimeout(() => fired.push('cleared'), 5);
    clock.clearTimeout(handle);
    await clock.advance(10, settled);
    expect(fired).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('runs the settle callback after every fired timer', async () => {
    const clock = new VirtualClock(0);
    const log: string[] = [];
    clock.setTimeout(() => log.push('t1'), 1);
    clock.setTimeout(() => log.push('t2'), 2);
    await clock.advance(5, () => {
      log.push('settle');
      return Promise.resolve();
    });
    expect(log).toEqual(['t1', 'settle', 't2', 'settle']);
  });

  it('gives each client a skewed now() on the shared timeline', async () => {
    const clock = new VirtualClock(10_000);
    const ahead = clock.view(500);
    const behind = clock.view(-500);
    expect([ahead.now(), behind.now()]).toEqual([10_500, 9_500]);
    const fired: string[] = [];
    ahead.setTimeout(() => fired.push('ahead'), 100);
    behind.setTimeout(() => fired.push('behind'), 50);
    await clock.advance(100, settled);
    expect(fired).toEqual(['behind', 'ahead']);
  });

  it('refuses negative delays', async () => {
    const clock = new VirtualClock(0);
    expect(() => clock.setTimeout(() => undefined, -1)).toThrow(RangeError);
    await expect(clock.advance(-1, settled)).rejects.toThrow(RangeError);
  });
});
