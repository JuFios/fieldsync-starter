import fc from 'fast-check';
import type { Profile } from './profiles';
import type { ActionParams } from './scenario';
import { StepCommand, type SimCommand, type Step } from './simulation';

/** A fast-check `oneof` over constants, weighted as in a profile's table. */
function weighted<K extends string>(weights: Readonly<Record<K, number>>): fc.Arbitrary<K> {
  const entries = (Object.entries(weights) as Array<[K, number]>).filter(([, weight]) => weight > 0);
  return fc.oneof(...entries.map(([key, weight]) => ({ weight, arbitrary: fc.constant(key) })));
}

const often = (weight: number, rarely: number): fc.Arbitrary<boolean> =>
  fc.oneof({ weight, arbitrary: fc.constant(true) }, { weight: rarely, arbitrary: fc.constant(false) });

const hex = (length: number) =>
  fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: length, maxLength: length });

const LIMITS = { title: 200, name: 100, description: 5000 } as const;
const WRENCH = '\u{1F527}';

/**
 * Text a user may type: mostly plain, also any Unicode (fast-check graphemes: non-ASCII, combining
 * marks, astral characters as surrogate pairs) and lengths at the limits: a title or name of exactly
 * its limit in UTF-16 units ending in an emoji, a description longer than its limit with an emoji
 * across the cut. With `invalid`, sometimes text the server must reject: empty, one unit too long, a
 * NUL character or an unpaired surrogate.
 */
export function textArb(field: keyof typeof LIMITS, invalid: boolean): fc.Arbitrary<string> {
  const max = LIMITS[field];
  const words = field === 'name' ? ['Seal', 'Bearing', 'Filter', 'Fuse'] : ['Pump', 'Valve', 'Belt', 'Motor', 'Sensor'];
  const atLimit = field === 'description' ? `${'x'.repeat(max - 1)}${WRENCH}tail` : `${'x'.repeat(max - 2)}${WRENCH}`;
  const variants = [
    { weight: 80, arbitrary: fc.tuple(fc.constantFrom(...words), hex(6)).map(([word, id]) => `${word} ${id}`) },
    { weight: 12, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }) },
    { weight: 5, arbitrary: fc.constant(atLimit) },
  ];
  if (invalid) {
    variants.push({
      weight: 3,
      arbitrary: fc.constantFrom('', 'x'.repeat(max + 1), 'pump\u0000room', 'pump \ud83d'),
    });
  }
  return fc.oneof(...variants);
}

/** The generated choices of a user action (see {@link ActionParams}). */
export function actionParamsArb(invalid: boolean): fc.Arbitrary<ActionParams> {
  return fc.record({
    hot: often(3, 1),
    pick: fc.nat(),
    sitePick: fc.nat(),
    title: textArb('title', invalid),
    description: fc.oneof(
      { weight: 7, arbitrary: fc.constant('') },
      { weight: 3, arbitrary: textArb('description', invalid) },
    ),
    editFields: fc.constantFrom('title' as const, 'description' as const, 'both' as const),
    offScript: often(1, 9),
    statusPick: fc.nat(),
    partName: textArb('name', invalid),
    quantity: fc.integer({ min: 1, max: 3 }),
    increase: fc.integer({ min: 1, max: 3 }),
    delta: fc.integer({ min: -3, max: 3 }),
  });
}

/** One command of the fault phase, weighted by the profile's step weights. */
export function stepArb(profile: Profile): fc.Arbitrary<Step> {
  const client = fc.nat({ max: profile.clients.length - 1 });
  const byKind: Record<Step['kind'], fc.Arbitrary<Step>> = {
    act: fc.record({
      kind: fc.constant('act' as const),
      client,
      intent: weighted(profile.actionWeights),
      params: actionParamsArb(profile.invalidText),
    }),
    sync: fc.record({ kind: fc.constant('sync' as const), client }),
    deliver: fc.record({
      kind: fc.constant('deliver' as const),
      pick: fc.nat(),
      fault: weighted(profile.requestFaults),
    }),
    respond: fc.record({
      kind: fc.constant('respond' as const),
      pick: fc.nat(),
      fault: weighted(profile.responseFaults),
    }),
    redeliver: fc.record({ kind: fc.constant('redeliver' as const), pick: fc.nat() }),
    tick: fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 100, max: profile.maxTickMs }) }),
    link: fc.record({ kind: fc.constant('link' as const), client, state: weighted(profile.linkStates) }),
    compact: fc.constant({ kind: 'compact' as const }),
    away: fc.record({ kind: fc.constant('away' as const), client }),
    reload: fc.record({ kind: fc.constant('reload' as const), client }),
    tab: fc.record({ kind: fc.constant('tab' as const), client }),
    poke: fc.record({ kind: fc.constant('poke' as const), pick: fc.nat() }),
    'drop-stream': fc.record({ kind: fc.constant('drop-stream' as const), client }),
  };
  const kinds = (Object.entries(profile.stepWeights) as Array<[Step['kind'], number]>).filter(([, w]) => w > 0);
  return fc.oneof(...kinds.map(([kind, weight]) => ({ weight, arbitrary: byKind[kind] })));
}

/**
 * The fault phase of a run as fast-check model-based commands (`fc.commands`): fast-check generates
 * them from the seed, runs them with `fc.asyncModelRun` and, on a failure, shrinks the list of
 * commands and each command's choices. `replayPath` is fast-check's replay hint printed with a
 * failure, used together with its seed and path.
 */
export function commandsArb(profile: Profile, replayPath?: string): fc.Arbitrary<Iterable<SimCommand>> {
  return fc.commands([stepArb(profile).map((step) => new StepCommand(step))], {
    maxCommands: profile.maxCommands,
    size: 'max',
    replayPath,
  });
}
