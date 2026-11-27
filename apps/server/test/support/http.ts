import type { INestApplication } from '@nestjs/common';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@fieldsync/sync-core';
import request from 'supertest';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: IncomingHttpHeaders;
  body: T;
}

/** Minimal JSON client for the application under test, over supertest; it speaks the current protocol. */
export class Api {
  constructor(private readonly app: INestApplication) {}

  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; body?: unknown; protocol?: string | null } = {},
  ): Promise<ApiResponse<T>> {
    const server = request(this.app.getHttpServer() as Server);
    let req = method === 'GET' ? server.get(path) : server.post(path);
    if (opts.token !== undefined) req = req.set('authorization', `Bearer ${opts.token}`);
    // Every request speaks the current protocol unless a test says otherwise (null: no header).
    const protocol = opts.protocol === undefined ? String(PROTOCOL_VERSION) : opts.protocol;
    if (protocol !== null) req = req.set(PROTOCOL_HEADER, protocol);
    // Every status is an answer for the tests, not an error of the request.
    req = req.ok(() => true);
    // Serialized here, so every value (null, strings, arrays) is sent as JSON, as a client would.
    if (opts.body !== undefined) req = req.set('content-type', 'application/json').send(JSON.stringify(opts.body));
    const res = await req;
    // application/json and application/problem+json (error answers).
    const json = /^application\/(problem\+)?json/.test(res.headers['content-type'] ?? '') && res.text;
    return { status: res.status, headers: res.headers, body: (json ? JSON.parse(res.text) : res.text) as T };
  }

  get<T = unknown>(path: string, token?: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, { token });
  }

  post<T = unknown>(path: string, body: unknown, token?: string): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { token, body });
  }
}
