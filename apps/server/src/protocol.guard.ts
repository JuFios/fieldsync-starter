import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@fieldsync/sync-core';
import type { Request } from 'express';
import { ProblemException } from './problem';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * The protocol versions this server speaks. A version leaves the range only once no supported
 * client sends it any more; the server keeps accepting the formats of every version in it.
 */
export const SUPPORTED_PROTOCOL = { min: 1, max: PROTOCOL_VERSION } as const;

/** How long a client newer than the server waits before it tries again (a rolling update in progress). */
export const SERVER_UPDATE_RETRY_SECONDS = 60;

/**
 * Checks the protocol version a client speaks (the `FieldSync-Protocol` header) before anything
 * else, the bearer token included, so an outdated client learns that it has to be updated whatever
 * else is wrong with its request:
 *
 * - no version (clients before versioning) or one below the range: 400 `CLIENT_UPDATE_REQUIRED`.
 *   A 400 and not a 426: RFC 9110 (15.5.22) requires a 426 to name a protocol in an `Upgrade`
 *   header, which switches protocols on the same connection (7.8); the code carries the meaning;
 * - above the range (the client was updated before this server): 503 `SERVER_UPDATE_REQUIRED` with
 *   `Retry-After`, since the server will be updated;
 * - a value that is not a version: 400 `BAD_REQUEST`.
 *
 * `details` holds the supported range. Routes marked `@Public()` (health) are not checked.
 * Registered before the AuthGuard as a global guard (NestJS guards run in registration order).
 */
@Injectable()
export class ProtocolGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    const header = ctx.switchToHttp().getRequest<Request>().headers[PROTOCOL_HEADER.toLowerCase()];
    const details = { min: SUPPORTED_PROTOCOL.min, max: SUPPORTED_PROTOCOL.max };
    if (header === undefined) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'CLIENT_UPDATE_REQUIRED',
        'This version of the app is no longer supported; update it to continue syncing',
        details,
      );
    }
    // Node joins repeated headers with ", "; only one plain decimal version is valid.
    const version = typeof header === 'string' && /^\d{1,9}$/.test(header.trim()) ? Number(header) : undefined;
    if (version === undefined) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        `${PROTOCOL_HEADER} must be a protocol version`,
      );
    }
    if (version < SUPPORTED_PROTOCOL.min) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'CLIENT_UPDATE_REQUIRED',
        'This version of the app is no longer supported; update it to continue syncing',
        { ...details, version },
      );
    }
    if (version > SUPPORTED_PROTOCOL.max) {
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'SERVER_UPDATE_REQUIRED',
        'The server does not speak this version of the app yet; try again later',
        { ...details, version },
        SERVER_UPDATE_RETRY_SECONDS,
      );
    }
    return true;
  }
}
