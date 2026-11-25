import { SafeTypeOrmLogger } from '../src/database/logger';

function capture() {
  const lines: Array<[string, string]> = [];
  const sink = {
    log: (m: string) => lines.push(['log', m]),
    warn: (m: string) => lines.push(['warn', m]),
    error: (m: string) => lines.push(['error', m]),
  };
  return { lines, logger: new SafeTypeOrmLogger(sink as never) };
}

const QUERY = `SELECT id, role
  FROM users WHERE token = $1`;

describe('SafeTypeOrmLogger', () => {
  it('logs failed queries without their parameters', () => {
    const { lines, logger } = capture();
    logger.logQueryError(new Error('connection reset'), QUERY, ['secret-token']);
    logger.logQueryError('timeout', QUERY, ['secret-token']);
    expect(lines).toEqual([
      ['error', 'Query failed: connection reset -- SELECT id, role FROM users WHERE token = $1'],
      ['error', 'Query failed: timeout -- SELECT id, role FROM users WHERE token = $1'],
    ]);
  });

  it('logs slow queries without their parameters', () => {
    const { lines, logger } = capture();
    logger.logQuerySlow(1500, QUERY, ['secret-token']);
    expect(lines).toEqual([['warn', 'Slow query (1500 ms): SELECT id, role FROM users WHERE token = $1']]);
  });

  it('does not log successful queries or schema builds', () => {
    const { lines, logger } = capture();
    logger.logQuery(QUERY, ['secret-token']);
    logger.logSchemaBuild('CREATE TABLE x');
    expect(lines).toEqual([]);
  });

  it('passes migration progress and driver messages through', () => {
    const { lines, logger } = capture();
    logger.logMigration('Migration InitialSchema has been executed successfully.');
    logger.log('warn', 'pool warning');
    logger.log('info', 'info message');
    expect(lines).toEqual([
      ['log', 'Migration InitialSchema has been executed successfully.'],
      ['warn', 'pool warning'],
      ['log', 'info message'],
    ]);
  });
});
