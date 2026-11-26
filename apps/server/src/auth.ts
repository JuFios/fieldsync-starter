import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Db } from './db';
import { IS_PUBLIC_KEY } from './public.decorator';

export interface AuthUser {
  id: string;
  role: 'admin' | 'technician';
}

export type AuthedRequest = Request & { user: AuthUser };

/**
 * Authenticates every request by its bearer token and attaches the user. Registered globally
 * (`APP_GUARD`); routes marked {@link Public} skip it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    let token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token && req.path === '/sync/stream' && typeof req.query.token === 'string') {
      token = req.query.token;
    }
    if (!token) throw new UnauthorizedException();
    const { rows } = await this.db.query<AuthUser>(`SELECT id, role FROM users WHERE token = $1`, [token]);
    if (rows.length === 0) throw new UnauthorizedException();
    req.user = rows[0];
    return true;
  }
}
