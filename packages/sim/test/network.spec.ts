import { SimNetwork, type NetworkEvent } from '../src/network';
import type { SimRequest, SimResponse, SimServer } from '../src/types';

/** Counts what reaches the server and answers every request with its sequence number. */
class CountingServer implements SimServer {
  readonly received: SimRequest[] = [];

  reset(): Promise<void> {
    return Promise.resolve();
  }

  liveRows() {
    return Promise.resolve([]);
  }

  send(request: SimRequest): Promise<SimResponse> {
    this.received.push(request);
    const body = JSON.stringify({ handled: this.received.length });
    return Promise.resolve({ status: 201, contentType: 'application/json', body, serverErrors: [] });
  }
}

type Outcome = { status: number; body: string } | { error: string };

function setup() {
  const server = new CountingServer();
  const events: NetworkEvent[] = [];
  const network = new SimNetwork(server, (e) => events.push(e));
  const fetchC1 = network.fetchFor('c1');
  let settled: Outcome | undefined;
  const send = () => {
    settled = undefined;
    fetchC1('http://fieldsync.sim/sync/push?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: '{"a":1}',
    }).then(
      async (res) => {
        settled = { status: res.status, body: await res.text() };
      },
      (err: Error) => {
        settled = { error: `${err.name}: ${err.message}` };
      },
    );
  };
  const outcome = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    return settled;
  };
  return { server, events, network, send, outcome };
}

describe('SimNetwork', () => {
  it('holds a request until it is delivered and its answer until it is handed back', async () => {
    const { server, network, send, outcome } = setup();
    send();
    expect(await outcome()).toBeUndefined();
    expect(network.queuedClients()).toEqual(['c1']);
    expect(server.received).toEqual([]);

    await network.deliver('c1', 'none');
    expect(server.received).toEqual([
      {
        method: 'POST',
        path: '/sync/push?x=1',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: '{"a":1}',
      },
    ]);
    expect(await outcome()).toBeUndefined();
    expect(network.answeredClients()).toEqual(['c1']);

    network.respond('c1', 'none');
    expect(await outcome()).toEqual({ status: 201, body: '{"handled":1}' });
    expect(network.idle).toBe(true);
  });

  it('loses a dropped request before the server sees it', async () => {
    const { server, network, send, outcome } = setup();
    send();
    await network.deliver('c1', 'drop-request');
    expect(server.received).toHaveLength(0);
    expect(await outcome()).toEqual({ error: 'TypeError: fetch failed' });
  });

  it('loses a dropped answer after the server handled the request', async () => {
    const { server, network, send, outcome } = setup();
    send();
    await network.deliver('c1', 'none');
    network.respond('c1', 'drop-response');
    expect(server.received).toHaveLength(1);
    expect(await outcome()).toEqual({ error: 'TypeError: fetch failed' });
  });

  it('answers 502 from a proxy after the server handled the request', async () => {
    const { server, network, send, outcome } = setup();
    send();
    await network.deliver('c1', 'none');
    network.respond('c1', 'bad-gateway');
    expect(server.received).toHaveLength(1);
    expect(await outcome()).toEqual({ status: 502, body: 'Bad Gateway' });
  });

  it('cuts an answer in the middle of its body after the server handled the request', async () => {
    const { server, network, send, outcome } = setup();
    send();
    await network.deliver('c1', 'none');
    network.respond('c1', 'truncate');
    expect(server.received).toHaveLength(1);
    expect(await outcome()).toEqual({ status: 201, body: '{"hand' });
  });

  it('lets the server handle a duplicated request twice and hands back the second answer', async () => {
    const { server, network, send, outcome } = setup();
    send();
    await network.deliver('c1', 'duplicate');
    expect(server.received).toHaveLength(2);
    network.respond('c1', 'none');
    expect(await outcome()).toEqual({ status: 201, body: '{"handled":2}' });
  });

  it('delivers a held copy of a request again later, and its answer reaches no one', async () => {
    const { server, network, send, outcome, events } = setup();
    send();
    await network.deliver('c1', 'hold-copy');
    network.respond('c1', 'none');
    expect(await outcome()).toEqual({ status: 201, body: '{"handled":1}' });
    expect(network.heldClients()).toEqual(['c1']);
    expect(network.idle).toBe(false);

    await network.redeliver('c1');
    expect(server.received).toHaveLength(2);
    expect(server.received[1]).toEqual(server.received[0]);
    expect(events.at(-1)).toMatchObject({ kind: 'redelivered', client: 'c1' });
    expect(network.idle).toBe(true);
  });

  it('never answers a hung request', async () => {
    const { server, network, send, outcome } = setup();
    send();
    await network.deliver('c1', 'hang');
    expect(server.received).toHaveLength(1);
    expect(network.hungClients()).toEqual(['c1']);
    expect(network.answeredClients()).toEqual([]);
    expect(network.idle).toBe(true);
    expect(await outcome()).toBeUndefined();
  });

  it('drops every request while the link is down', async () => {
    const { server, network, send, outcome } = setup();
    network.setLink('c1', 'down');
    send();
    await network.deliver('c1', 'none');
    expect(server.received).toHaveLength(0);
    expect(await outcome()).toEqual({ error: 'TypeError: fetch failed' });
  });

  it('lets requests through but loses every answer on a one-way partition', async () => {
    const { server, network, send, outcome } = setup();
    send();
    network.setLink('c1', 'responses-lost');
    await network.deliver('c1', 'none');
    network.respond('c1', 'none');
    expect(server.received).toHaveLength(1);
    expect(await outcome()).toEqual({ error: 'TypeError: fetch failed' });
  });

  it('works again once a link is back up', async () => {
    const { network, send, outcome } = setup();
    network.setLink('c1', 'down');
    network.setLink('c1', 'up');
    send();
    await network.deliver('c1', 'none');
    network.respond('c1', 'none');
    expect(await outcome()).toEqual({ status: 201, body: '{"handled":1}' });
  });

  it('records the effective fault, not the requested one', async () => {
    const { network, send, events } = setup();
    network.setLink('c1', 'down');
    send();
    await network.deliver('c1', 'duplicate');
    expect(events.filter((e) => e.kind === 'delivered')).toEqual([
      { kind: 'delivered', client: 'c1', exchange: 1, fault: 'drop-request', responses: [] },
    ]);
  });

  it('refuses to deliver or answer what is not there', async () => {
    const { network } = setup();
    await expect(network.deliver('c1', 'none')).rejects.toThrow('no queued request');
    expect(() => network.respond('c1', 'none')).toThrow('no answer waiting');
    await expect(network.redeliver('c1')).rejects.toThrow('no held copy');
  });
});
