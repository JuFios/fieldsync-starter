import { Agent, createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HttpShutdownService } from '../../src/http-shutdown.service';

describe('HttpShutdownService', () => {
  let server: Server;
  let service: HttpShutdownService;
  /** Responses the server was asked for and has not sent; the test sends them. */
  let waiting: ServerResponse[];
  let arrived: () => void;

  beforeEach(async () => {
    waiting = [];
    server = createServer((_req, res) => {
      waiting.push(res);
      arrived();
    });
    const module = await Test.createTestingModule({
      providers: [
        HttpShutdownService,
        { provide: HttpAdapterHost, useValue: { httpAdapter: { getHttpServer: () => server } } },
      ],
    }).compile();
    service = module.get(HttpShutdownService);
    // Follows the server's connections from before it listens, as in the application.
    service.onModuleInit();
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it('waits for the request in flight, then closes the connection its client keeps alive', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
      let connectionClosed = false;
      const answer = new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, agent }, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => resolve(`${res.statusCode} ${text}`));
        });
        req.on('socket', (socket) => socket.once('close', () => (connectionClosed = true)));
        req.on('error', reject);
        req.end();
      });
      await requestArrived;

      let stopped = false;
      const stopping = service.beforeApplicationShutdown().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect({ stopped, listening: server.listening, connectionClosed }).toEqual({
        stopped: false,
        listening: false,
        connectionClosed: false,
      });

      waiting[0]?.end('done');
      await expect(answer).resolves.toBe('200 done');
      // At once: a server left to the keep-alive timeout would take 5 s.
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      agent.destroy();
    }
  }, 3_000);

  it('has nothing to wait for with a server that never listened', async () => {
    await expect(service.beforeApplicationShutdown()).resolves.toBeUndefined();
  });
});
