import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthGuard, type AuthedRequest } from '../../src/auth';
import { Db } from '../../src/db';
import { mockDb, result, type MockDb } from './support';

const USER = { id: 'user-1', role: 'technician' as const };

class Handler {}
function handler() {
  return undefined;
}

function context(req: Partial<AuthedRequest>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Handler,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function request(opts: { authorization?: string; path?: string; token?: string } = {}): Partial<AuthedRequest> {
  return {
    headers: opts.authorization === undefined ? {} : { authorization: opts.authorization },
    path: opts.path ?? '/me',
    query: opts.token === undefined ? {} : { token: opts.token },
  } as Partial<AuthedRequest>;
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let db: MockDb;
  let reflector: Reflector;

  beforeEach(async () => {
    db = mockDb();
    db.query.mockImplementation((_sql, params) => Promise.resolve(result(params?.[0] === 'good-token' ? [USER] : [])));
    const moduleRef = await Test.createTestingModule({
      providers: [AuthGuard, Reflector, { provide: Db, useValue: db }],
    }).compile();
    guard = moduleRef.get(AuthGuard);
    reflector = moduleRef.get(Reflector);
  });

  it('lets public routes through without a token or a query', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    await expect(guard.canActivate(context(request()))).resolves.toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('attaches the user of a valid bearer token', async () => {
    const req = request({ authorization: 'Bearer good-token' });
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    expect(req.user).toEqual(USER);
    expect(db.query).toHaveBeenCalledWith('SELECT id, role FROM users WHERE token = $1', ['good-token']);
  });

  it.each([
    ['no header', request()],
    ['an unknown token', request({ authorization: 'Bearer bad-token' })],
    ['another scheme', request({ authorization: 'Basic good-token' })],
    ['an empty bearer token', request({ authorization: 'Bearer ' })],
    ['a query token outside the stream', request({ path: '/me', token: 'good-token' })],
  ])('rejects a request with %s', async (_name, req) => {
    await expect(guard.canActivate(context(req))).rejects.toThrow(UnauthorizedException);
  });

  it('accepts the token as a query parameter on the event stream only', async () => {
    const req = request({ path: '/sync/stream', token: 'good-token' });
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    expect(req.user).toEqual(USER);
  });
});
