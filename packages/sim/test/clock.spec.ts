import { SimClock } from '../src/clock';

const settled = () => Promise.resolve();

describe('SimClock', () => {
  it('moves only when advanced', async () => {
    const clock = new SimClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.advance(250, settled);
    expect(clock.now()).toBe(1_250);
  });

  it('fires due timers in due order, ties in creation order, at their due time', async () => {
    const clock = new SimClock(0);
    const view = clock.view();
    const fired: string[] = [];
    view.setTimeout(() => fired.push(`b@${clock.now()}`), 20);
    view.setTimeout(() => fired.push(`a@${clock.now()}`), 10);
    view.setTimeout(() => fired.push(`c@${clock.now()}`), 20);
    view.setTimeout(() => fired.push('late'), 31);
    expect(await clock.advance(30, settled)).toBe(3);
    expect(fired).toEqual(['a@10', 'b@20', 'c@20']);
    expect(clock.now()).toBe(30);
    expect(clock.pendingTimers).toBe(1);
  });

  it('fires a timer set by another timer if it falls due within the same advance', async () => {
    const clock = new SimClock(0);
    const view = clock.view();
    const fired: number[] = [];
    view.setTimeout(() => {
      fired.push(clock.now());
      view.setTimeout(() => fired.push(clock.now()), 5);
    }, 5);
    await clock.advance(10, settled);
    expect(fired).toEqual([5, 10]);
  });

  it('does not fire a cleared timer', async () => {
    const clock = new SimClock(0);
    const view = clock.view();
    const fired: string[] = [];
    const handle = view.setTimeout(() => fired.push('cleared'), 5);
    view.clearTimeout(handle);
    await clock.advance(10, settled);
    expect(fired).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('lets the promise chain a timer started run before the next timer fires, then settles', async () => {
    const clock = new SimClock(0);
    const view = clock.view();
    const log: string[] = [];
    const work = async (name: string) => {
      log.push(`${name} start`);
      await Promise.resolve();
      await Promise.resolve();
      log.push(`${name} done`);
    };
    view.setTimeout(() => void work('t1'), 1);
    view.setTimeout(() => void work('t2'), 1);
    await clock.advance(5, () => {
      log.push('settle');
      return Promise.resolve();
    });
    expect(log).toEqual(['t1 start', 't1 done', 't2 start', 't2 done', 'settle']);
  });

  it('jumps to the next timer only, and reports how far it moved', async () => {
    const clock = new SimClock(100);
    const view = clock.view();
    const fired: number[] = [];
    view.setTimeout(() => fired.push(clock.now()), 40);
    view.setTimeout(() => fired.push(clock.now()), 70);
    expect(await clock.advanceToNext(settled)).toBe(40);
    expect(fired).toEqual([140]);
    expect(await clock.advanceToNext(settled)).toBe(30);
    expect(await clock.advanceToNext(settled)).toBeUndefined();
    expect(clock.firedTimers).toBe(2);
  });

  it('gives each client a skewed now() on the shared timeline', async () => {
    const clock = new SimClock(10_000);
    const ahead = clock.view(500);
    const behind = clock.view(-500);
    expect([ahead.now(), behind.now()]).toEqual([10_500, 9_500]);
    const fired: string[] = [];
    ahead.setTimeout(() => fired.push('ahead'), 100);
    behind.setTimeout(() => fired.push('behind'), 50);
    await clock.advance(100, settled);
    expect(fired).toEqual(['behind', 'ahead']);
  });

  it('leaves the global clock and timers alone', async () => {
    const clock = new SimClock(0);
    const before = Date.now();
    await clock.advance(86_400_000, settled);
    expect(Date.now() - before).toBeLessThan(60_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  });

  it('refuses to move time backwards', async () => {
    const clock = new SimClock(0);
    await expect(clock.advance(-1, settled)).rejects.toThrow(RangeError);
  });
});
