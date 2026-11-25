export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** Minimal JSON client for the server under test. */
export class Api {
  constructor(private readonly baseUrl: string) {}

  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text && res.headers.get('content-type')?.includes('application/json')) body = JSON.parse(text);
    return { status: res.status, headers: res.headers, body: body as T };
  }

  get<T = unknown>(path: string, token?: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, { token });
  }

  post<T = unknown>(path: string, body: unknown, token?: string): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { token, body });
  }
}
