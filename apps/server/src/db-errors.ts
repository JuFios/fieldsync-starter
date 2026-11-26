import { HttpStatus } from '@nestjs/common';
import { MutationRejected } from '@fieldsync/sync-core';
import { ProblemException } from './problem';

/**
 * SQLSTATE classes and codes after which the same transaction can succeed if it is simply run again
 * (PostgreSQL 16, Appendix A): connection exceptions (08), transaction rollbacks such as
 * serialization failures and deadlocks (40), insufficient resources (53), operator intervention such
 * as a cancelled statement or an administrator shutdown (57), a lock that was not available in time
 * (55P03, lock_timeout) and a session ended for idling in a transaction (25P03).
 */
const TRANSIENT_CLASSES = new Set(['08', '40', '53', '57']);
const TRANSIENT_CODES = new Set(['55P03', '25P03']);
/** Errors of the network or of a connection the pool already lost, which carry no SQLSTATE. */
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH']);
/**
 * The whole message of node-postgres errors for a connection that broke, which carry no code.
 * Matched whole, never as a substring: other messages can embed text a client sent.
 */
const TRANSIENT_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
]);

/** Seconds a client should wait before retrying after a transient failure (the Retry-After header). */
export const RETRY_AFTER_SECONDS = 1;

/** The error, its TypeORM driver error and its causes, outermost first. */
function chain(err: unknown): unknown[] {
  const seen: unknown[] = [];
  for (let e = err; e !== null && typeof e === 'object' && !seen.includes(e);) {
    seen.push(e);
    const next = (e as { driverError?: unknown; cause?: unknown }).driverError ?? (e as { cause?: unknown }).cause;
    e = next;
  }
  return seen;
}

/**
 * Whether running the same work again can succeed: the database was busy or unreachable, not wrong
 * about the data. Looks at the error, TypeORM's `driverError` and the `cause` chain. A mutator's
 * rejection is final whatever its message says.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof MutationRejected) return false;
  return chain(err).some((e) => {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === 'string') {
      if (/^[0-9A-Z]{5}$/.test(code) && (TRANSIENT_CODES.has(code) || TRANSIENT_CLASSES.has(code.slice(0, 2)))) {
        return true;
      }
      if (TRANSIENT_NODE_CODES.has(code)) return true;
    }
    return code === undefined && typeof message === 'string' && TRANSIENT_MESSAGES.has(message);
  });
}

/** The 503 answer for a transient failure: nothing of the failed work was applied. */
export function retryLater(): ProblemException {
  return new ProblemException(
    HttpStatus.SERVICE_UNAVAILABLE,
    'TRANSIENT',
    'The database is busy or unavailable; nothing was applied, retry later',
    undefined,
    RETRY_AFTER_SECONDS,
  );
}
