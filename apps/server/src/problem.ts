import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/** The media type of every error answer (RFC 9457, section 3). */
export const PROBLEM_JSON = 'application/problem+json';

/** The codes of error answers, so a client can act on them without parsing `detail`. */
export const PROBLEM_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'MUTATION_OUT_OF_ORDER',
  'RESET_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'TOO_MANY_REQUESTS',
  'TRANSIENT',
  'INTERNAL',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * An error answer in the format of RFC 9457: `type` is `about:blank` (no semantics beyond the status
 * code, section 4.2.1), `title` the status phrase, `detail` a sentence for people (never details of
 * the implementation, section 5), plus the extension members `code` (stable, for programs),
 * `details` (facts the client can act on) and `errors` (one message per invalid field).
 */
export interface Problem {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  code: ProblemCode;
  details?: Record<string, unknown>;
  errors?: string[];
}

/** An HTTP error that carries a problem code and details; the filter answers it as a problem. */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ProblemCode,
    detail: string,
    readonly details?: Record<string, unknown>,
    /** Seconds after which a retry may succeed (the `Retry-After` header). */
    readonly retryAfterSeconds?: number,
  ) {
    super(detail, status);
  }
}

const CODE_BY_STATUS: Partial<Record<number, ProblemCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  // A gap in mutation ids is a ProblemException with its own code; any other conflict is generic.
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'TOO_MANY_REQUESTS',
  503: 'TRANSIENT',
};

const TITLES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * An error of the body parser (it sets `type` and `status`, see the body-parser documentation).
 * Invalid JSON never gets here: Nest turns its SyntaxError into a BadRequestException.
 */
function bodyParserError(e: unknown): { status: number; type: string } | undefined {
  const err = e as { type?: unknown; status?: unknown } | null;
  return err !== null && typeof err === 'object' && typeof err.type === 'string' && typeof err.status === 'number'
    ? { status: err.status, type: err.type }
    : undefined;
}

/** The problem an exception is answered with, and the Retry-After it needs, if any. */
export function problemOf(exception: unknown): { problem: Problem; retryAfterSeconds?: number } {
  const make = (status: number, code: ProblemCode, detail: string, extra: Partial<Problem> = {}): Problem => ({
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    code,
    ...extra,
  });
  if (exception instanceof ProblemException) {
    const extra = exception.details === undefined ? {} : { details: exception.details };
    return {
      problem: make(exception.getStatus(), exception.code, exception.message, extra),
      retryAfterSeconds: exception.retryAfterSeconds,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    // ValidationPipe answers { message: string[] }: one message per invalid field.
    const messages =
      typeof response === 'object' && response !== null ? (response as { message?: unknown }).message : undefined;
    const errors = Array.isArray(messages) ? messages.map(String) : undefined;
    const detail = errors ? 'The request is not valid' : exception.message;
    return { problem: make(status, CODE_BY_STATUS[status] ?? 'BAD_REQUEST', detail, errors ? { errors } : {}) };
  }
  const parser = bodyParserError(exception);
  if (parser?.type === 'entity.too.large') {
    return { problem: make(413, 'PAYLOAD_TOO_LARGE', 'The request body is larger than the server accepts') };
  }
  if (parser !== undefined && parser.status >= 400 && parser.status < 500) {
    return {
      problem: make(parser.status, CODE_BY_STATUS[parser.status] ?? 'BAD_REQUEST', 'The request body cannot be read'),
    };
  }
  return { problem: make(500, 'INTERNAL', 'The server could not handle the request') };
}

/**
 * Answers every error as a problem (RFC 9457). Registered with APP_FILTER, so it gets dependency
 * injection and covers every route; it catches everything (`@Catch()`) and replies through the
 * HTTP adapter, as the NestJS exception-filter documentation describes. Unexpected errors are
 * logged with their stack; the client only learns that the server failed.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const response: unknown = host.switchToHttp().getResponse();
    const { problem, retryAfterSeconds } = problemOf(exception);
    if (problem.code === 'INTERNAL') {
      this.logger.error('Unhandled error', exception instanceof Error ? exception.stack : String(exception));
    }
    // An event stream that already started cannot carry an error answer any more.
    if ((response as { headersSent?: boolean }).headersSent) {
      httpAdapter.end(response);
      return;
    }
    httpAdapter.setHeader(response, 'Content-Type', PROBLEM_JSON);
    if (retryAfterSeconds !== undefined) httpAdapter.setHeader(response, 'Retry-After', String(retryAfterSeconds));
    // A 410 is heuristically cacheable (RFC 9110, section 15.1); a reset must reach the client every time.
    if (problem.status === 410) httpAdapter.setHeader(response, 'Cache-Control', 'no-store');
    httpAdapter.reply(response, problem, problem.status);
  }
}
