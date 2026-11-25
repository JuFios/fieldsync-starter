import ConnectionParameters from 'pg/lib/connection-parameters';
import { createDataSource } from '../src/database/data-source';

// Capture the options TypeORM gives pg's Pool instead of connecting.
jest.mock('pg', () => {
  const actual: Record<string, unknown> = jest.requireActual('pg');
  return {
    ...actual,
    Pool: jest.fn(() => {
      throw new Error('pool options captured');
    }),
  };
});

/** Where pg would connect for DATABASE_URL, after TypeORM has parsed the URL its own way. */
async function effectiveConnection(url: string): Promise<ConnectionParameters> {
  const { Pool } = jest.requireMock<{ Pool: jest.Mock<never, [object]> }>('pg');
  Pool.mockClear();
  const ds = createDataSource({ url, poolSize: 1, applicationName: 'fieldsync-test' });
  await expect(ds.initialize()).rejects.toThrow('pool options captured');
  expect(Pool).toHaveBeenCalledTimes(1);
  return new ConnectionParameters(Pool.mock.calls[0][0]);
}

describe('DATABASE_URL through TypeORM to pg', () => {
  it('connects to the Unix socket directory given as ?host=', async () => {
    const params = await effectiveConnection('postgresql://app:secret@/fieldsync?host=/var/run/postgresql');
    expect({ host: params.host, user: params.user, database: params.database }).toEqual({
      host: '/var/run/postgresql',
      user: 'app',
      database: 'fieldsync',
    });
  });

  it('connects to the host and port of an ordinary URL', async () => {
    const params = await effectiveConnection('postgres://app:secret@db.internal:6543/fieldsync');
    expect({ host: params.host, port: params.port, database: params.database }).toEqual({
      host: 'db.internal',
      port: 6543,
      database: 'fieldsync',
    });
  });
});
