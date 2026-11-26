import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { StreamService } from '../../src/stream.service';

const NORTH = 'site-north';
const SOUTH = 'site-south';

function response() {
  return { writeHead: jest.fn(), write: jest.fn() };
}

describe('StreamService', () => {
  let streams: StreamService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ providers: [StreamService] }).compile();
    streams = moduleRef.get(StreamService);
  });

  describe('add', () => {
    it('opens an event stream with a reconnection delay and counts the subscriber', () => {
      const res = response();
      streams.add([NORTH], res as unknown as Response);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      expect(res.write).toHaveBeenCalledWith('retry: 3000\n\n');
      expect(streams.count).toBe(1);
    });
  });

  describe('count', () => {
    it('is zero without subscribers', () => {
      expect(streams.count).toBe(0);
    });
  });

  describe('notify', () => {
    it('pokes each subscriber of a changed site once, and nobody else', () => {
      const north = response();
      const south = response();
      const both = response();
      streams.add([NORTH], north as unknown as Response);
      streams.add([SOUTH], south as unknown as Response);
      streams.add([NORTH, SOUTH], both as unknown as Response);
      for (const res of [north, south, both]) res.write.mockClear();

      streams.notify([NORTH, SOUTH]);
      streams.notify([NORTH]);

      expect(north.write.mock.calls).toEqual([['event: poke\ndata: {}\n\n'], ['event: poke\ndata: {}\n\n']]);
      expect(south.write.mock.calls).toEqual([['event: poke\ndata: {}\n\n']]);
      expect(both.write.mock.calls).toEqual([['event: poke\ndata: {}\n\n'], ['event: poke\ndata: {}\n\n']]);
    });

    it('writes nothing when no site has subscribers', () => {
      const north = response();
      streams.add([NORTH], north as unknown as Response);
      north.write.mockClear();
      streams.notify([SOUTH]);
      expect(north.write).not.toHaveBeenCalled();
    });
  });
});
