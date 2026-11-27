import { BadRequestException, ConflictException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ProblemException, problemOf } from '../src/problem';

describe('problemOf', () => {
  it('answers a problem exception with its code, details and Retry-After', () => {
    const e = new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, 'TRANSIENT', 'Try again', { reason: 'x' }, 2);
    expect(problemOf(e)).toEqual({
      problem: {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Try again',
        code: 'TRANSIENT',
        details: { reason: 'x' },
      },
      retryAfterSeconds: 2,
    });
  });

  it('lists the messages of a failed validation', () => {
    const e = new BadRequestException(['cursor must be an integer from 0 to 9007199254740991']);
    expect(problemOf(e).problem).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The request is not valid',
      code: 'BAD_REQUEST',
      errors: ['cursor must be an integer from 0 to 9007199254740991'],
    });
  });

  it('keeps the status and message of other HTTP exceptions', () => {
    expect(problemOf(new UnauthorizedException('Missing bearer token')).problem).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      detail: 'Missing bearer token',
    });
  });

  it('gives a conflict that is not a gap in mutation ids a code of its own', () => {
    // MUTATION_OUT_OF_ORDER tells the client to reload its state; only the push may say so.
    expect(problemOf(new ConflictException('Taken')).problem).toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it.each([
    [{ type: 'entity.too.large', status: 413 }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ type: 'encoding.unsupported', status: 415 }, 415, 'BAD_REQUEST'],
  ])('answers the body parser error %j with %d %s', (error, status, code) => {
    expect(problemOf(Object.assign(new Error('parser'), error)).problem).toMatchObject({ status, code });
  });

  it('answers any other error with 500 and nothing about it', () => {
    const { problem } = problemOf(new TypeError('Cannot read properties of undefined (secret)'));
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'The server could not handle the request',
      code: 'INTERNAL',
    });
  });
});
