import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Subscription } from 'rxjs';
import { POKE_WINDOW_MS, StreamService, type StreamClient } from '../../src/stream.service';

const NORTH = 'site-north';
const SOUTH = 'site-south';
const HEARTBEAT_MS = 10_000;

/** A client of one stream; `stuck` makes its writes back up, `dropped` counts the server closing it. */
function client(sites: string[]) {
  const state = { stuck: false, dropped: 0 };
  const stream: StreamClient = {
    sites: () => Promise.resolve(sites),
    backedUp: () => state.stuck,
    drop: () => {
      state.dropped += 1;
    },
  };
  return { stream, state };
}

/** Streams a test opened; every one is unsubscribed after the test, so no heartbeat outlives it. */
const opened: Subscription[] = [];

/** Subscribes as Nest does and records the event types and whether the stream ended. */
function listen(service: StreamService, stream: StreamClient) {
  const events: Array<{ type: string | undefined; data: MessageEvent['data'] }> = [];
  const result = { events, completed: false, subscription: undefined as Subscription | undefined };
  result.subscription = service.events(stream).subscribe({
    next: (e) => events.push({ type: e.type, data: e.data }),
    complete: () => (result.completed = true),
  });
  opened.push(result.subscription);
  return result;
}

const types = (l: ReturnType<typeof listen>) => l.events.map((e) => e.type);

describe('StreamService', () => {
  let streams: StreamService;

  beforeEach(async () => {
    jest.useFakeTimers();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StreamService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'STREAM_HEARTBEAT_MS' ? HEARTBEAT_MS : undefined) },
        },
      ],
    }).compile();
    streams = moduleRef.get(StreamService);
  });

  afterEach(() => {
    for (const s of opened.splice(0)) s.unsubscribe();
    jest.useRealTimers();
  });

  describe('events', () => {
    it('starts with a ready event that carries the heartbeat interval, and counts the stream', async () => {
      const l = listen(streams, client([NORTH]).stream);
      await jest.advanceTimersByTimeAsync(0);
      expect(l.events).toEqual([{ type: 'ready', data: { heartbeatMs: HEARTBEAT_MS } }]);
      expect(streams.count).toBe(1);
    });

    it('removes the stream when the subscriber unsubscribes, as Nest does when the connection closes', async () => {
      const l = listen(streams, client([NORTH]).stream);
      await jest.advanceTimersByTimeAsync(0);
      l.subscription?.unsubscribe();
      expect(streams.count).toBe(0);
      await jest.advanceTimersByTimeAsync(3 * HEARTBEAT_MS);
      expect(types(l)).toEqual(['ready']);
    });

    it('registers nothing when the connection closes before the sites are known', async () => {
      const l = listen(streams, client([NORTH]).stream);
      l.subscription?.unsubscribe();
      await jest.advanceTimersByTimeAsync(0);
      expect(streams.count).toBe(0);
    });

    it('sends a heartbeat every interval while the stream is idle', async () => {
      const l = listen(streams, client([NORTH]).stream);
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
      expect(types(l)).toEqual(['ready']);
      await jest.advanceTimersByTimeAsync(1);
      expect(types(l)).toEqual(['ready', 'heartbeat']);
      await jest.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
      expect(types(l)).toEqual(['ready', 'heartbeat', 'heartbeat', 'heartbeat']);
    });

    it('drops a client whose writes stay backed up for a whole interval, and only then', async () => {
      const { stream, state } = client([NORTH]);
      const l = listen(streams, stream);
      await jest.advanceTimersByTimeAsync(0);
      state.stuck = true;
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(state.dropped).toBe(0);
      state.stuck = false;
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(state.dropped).toBe(0);
      state.stuck = true;
      await jest.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
      expect(state.dropped).toBe(1);
      expect(types(l)).toEqual(['ready', 'heartbeat']);
    });
  });

  describe('notify', () => {
    it('pokes each stream of a changed site, and nobody else', async () => {
      const north = listen(streams, client([NORTH]).stream);
      const south = listen(streams, client([SOUTH]).stream);
      const both = listen(streams, client([NORTH, SOUTH]).stream);
      await jest.advanceTimersByTimeAsync(0);

      streams.notify([NORTH]);
      await jest.advanceTimersByTimeAsync(0);

      expect(types(north)).toEqual(['ready', 'poke']);
      expect(types(south)).toEqual(['ready']);
      expect(types(both)).toEqual(['ready', 'poke']);
    });

    it('sends the first poke at once and merges the rest of a burst into one at the end of the window', async () => {
      const l = listen(streams, client([NORTH]).stream);
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 100; i += 1) streams.notify([NORTH]);
      await jest.advanceTimersByTimeAsync(0);
      expect(types(l)).toEqual(['ready', 'poke']);
      await jest.advanceTimersByTimeAsync(POKE_WINDOW_MS);
      expect(types(l)).toEqual(['ready', 'poke', 'poke']);
      await jest.advanceTimersByTimeAsync(10 * POKE_WINDOW_MS);
      expect(types(l)).toEqual(['ready', 'poke', 'poke']);
    });

    it('writes nothing when no stream has the site', async () => {
      const l = listen(streams, client([NORTH]).stream);
      await jest.advanceTimersByTimeAsync(0);
      streams.notify([SOUTH]);
      await jest.advanceTimersByTimeAsync(POKE_WINDOW_MS);
      expect(types(l)).toEqual(['ready']);
    });
  });

  describe('count', () => {
    it('is zero without streams', () => {
      expect(streams.count).toBe(0);
    });
  });
});
