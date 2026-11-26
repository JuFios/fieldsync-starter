import { QueryFailedError } from 'typeorm';
import { isTransient } from '../src/db-errors';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const typeorm = (code: string) => new QueryFailedError('SELECT 1', [], pgError(code));

describe('isTransient', () => {
  it.each([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
    ['55P03', 'lock_not_available (lock_timeout)'],
    ['57014', 'query_canceled (statement_timeout)'],
    ['25P03', 'idle_in_transaction_session_timeout'],
    ['57P01', 'admin_shutdown'],
    ['08006', 'connection_failure'],
    ['53300', 'too_many_connections'],
  ])('treats %s (%s) as transient, also inside a TypeORM error', (code) => {
    expect([isTransient(pgError(code)), isTransient(typeorm(code))]).toEqual([true, true]);
  });

  it.each([
    ['22P05', 'untranslatable_character'],
    ['23505', 'unique_violation'],
    ['42703', 'undefined_column'],
    ['22003', 'numeric_value_out_of_range'],
  ])('treats %s (%s) as a deterministic failure', (code) => {
    expect([isTransient(pgError(code)), isTransient(typeorm(code))]).toEqual([false, false]);
  });

  it.each([
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })],
    [new Error('Connection terminated unexpectedly')],
    [new Error('Rollback to savepoint failed', { cause: pgError('08006') })],
  ])('treats a lost connection as transient: %s', (err) => {
    expect(isTransient(err)).toBe(true);
  });

  it.each([
    [new TypeError('x is not a function')],
    ['a string'],
    [null],
    [Object.assign(new Error('x'), { code: 'ERR_X' })],
  ])('treats anything else as not transient: %s', (err) => {
    expect(isTransient(err)).toBe(false);
  });
});
