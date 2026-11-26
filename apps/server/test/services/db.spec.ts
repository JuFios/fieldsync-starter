import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Db, SavepointRollbackError } from '../../src/db';
import { isTransient } from '../../src/db-errors';
import { mockConfig } from './support';

/**
 * A QueryRunner double that records the transaction calls in order. Like TypeORM's, a nested
 * transaction is a savepoint.
 */
function mockRunner() {
  const calls: string[] = [];
  let depth = 0;
  const runner = {
    calls,
    isReleased: false,
    get isTransactionActive() {
      return depth > 0;
    },
    set isTransactionActive(active: boolean) {
      depth = active ? Math.max(depth, 1) : 0;
    },
    query: jest.fn((sql: string) => {
      calls.push(`query ${sql}`);
      return Promise.resolve({ records: [{ n: 1 }], affected: undefined as number | undefined });
    }),
    connect: jest.fn(() => {
      calls.push('connect');
      return Promise.resolve();
    }),
    startTransaction: jest.fn(() => {
      calls.push(depth === 0 ? 'begin' : 'savepoint');
      depth += 1;
      return Promise.resolve();
    }),
    commitTransaction: jest.fn(() => {
      depth -= 1;
      calls.push(depth === 0 ? 'commit' : 'release savepoint');
      return Promise.resolve();
    }),
    rollbackTransaction: jest.fn(() => {
      depth -= 1;
      calls.push(depth === 0 ? 'rollback' : 'rollback to savepoint');
      return Promise.resolve();
    }),
    release: jest.fn(() => {
      calls.push('release');
      runner.isReleased = true;
      return Promise.resolve();
    }),
  };
  return runner;
}

describe('Db', () => {
  let db: Db;
  let runner: ReturnType<typeof mockRunner>;
  let dataSource: {
    createQueryRunner: jest.Mock;
    query: jest.Mock;
    options: object;
    migrations: Array<{ name?: string }>;
  };
  let settings: Record<string, unknown>;

  async function build(): Promise<Db> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        Db,
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: mockConfig(settings) },
      ],
    }).compile();
    return moduleRef.get(Db);
  }

  beforeEach(async () => {
    runner = mockRunner();
    settings = { SEED_DEMO: false };
    dataSource = {
      createQueryRunner: jest.fn(() => runner),
      query: jest.fn(),
      options: { migrationsTableName: 'schema_migrations' },
      migrations: [{ name: 'InitialSchema1795564800000' }],
    };
    db = await build();
  });

  describe('query', () => {
    it('runs one statement on its own runner, returns rows and count, and releases the runner', async () => {
      await expect(db.query('SELECT 1 AS n', [])).resolves.toEqual({ rows: [{ n: 1 }], rowCount: 1 });
      expect(runner.query).toHaveBeenCalledWith('SELECT 1 AS n', [], true);
      expect(runner.calls).toEqual(['query SELECT 1 AS n', 'release']);
    });

    it('reports the rows an UPDATE or DELETE changed as rowCount', async () => {
      runner.query.mockResolvedValueOnce({ records: [], affected: 3 });
      await expect(db.query('DELETE FROM change_log')).resolves.toEqual({ rows: [], rowCount: 3 });
    });

    it('releases the runner when the statement fails', async () => {
      runner.query.mockRejectedValueOnce(new Error('syntax error'));
      await expect(db.query('SELEC 1')).rejects.toThrow('syntax error');
      expect(runner.release).toHaveBeenCalled();
    });
  });

  describe('tx', () => {
    it('commits when the callback resolves and returns its result', async () => {
      await expect(db.tx(async (sql) => (await sql.query('UPDATE t')).rowCount)).resolves.toBe(1);
      expect(runner.calls).toEqual(['connect', 'begin', 'query UPDATE t', 'commit', 'release']);
    });

    it('rolls back and rethrows when the callback throws', async () => {
      await expect(db.tx(() => Promise.reject(new Error('rejected')))).rejects.toThrow('rejected');
      expect(runner.calls).toEqual(['connect', 'begin', 'rollback', 'release']);
    });

    it('keeps the original error when the rollback fails, and logs the rollback failure', async () => {
      runner.rollbackTransaction.mockRejectedValueOnce(new Error('connection terminated'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await expect(db.tx(() => Promise.reject(new Error('rejected')))).rejects.toThrow('rejected');
        expect(warn).toHaveBeenCalledWith('Rollback failed after "rejected": connection terminated');
        expect(runner.release).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('does not roll back a transaction that is no longer active', async () => {
      runner.commitTransaction.mockImplementationOnce(() => {
        runner.isTransactionActive = false;
        return Promise.reject(new Error('commit failed'));
      });
      await expect(db.tx(() => Promise.resolve())).rejects.toThrow('commit failed');
      expect(runner.rollbackTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });

    it('starts the transaction with the given isolation and read-only mode', async () => {
      await db.tx(() => Promise.resolve(), { isolation: 'REPEATABLE READ', readOnly: true });
      expect(runner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
      expect(runner.calls).toEqual(['connect', 'begin', 'query SET TRANSACTION READ ONLY', 'commit', 'release']);
    });

    it('starts a read-write transaction with the default isolation when nothing is asked for', async () => {
      await db.tx(() => Promise.resolve());
      expect(runner.startTransaction).toHaveBeenCalledWith(undefined);
      expect(runner.calls).toEqual(['connect', 'begin', 'commit', 'release']);
    });

    describe('savepoint', () => {
      it('releases the savepoint when its callback resolves, inside the transaction', async () => {
        const result = await db.tx((sql) => sql.savepoint(async () => (await sql.query('UPDATE t')).rowCount));
        expect(result).toBe(1);
        expect(runner.calls).toEqual([
          'connect',
          'begin',
          'savepoint',
          'query UPDATE t',
          'release savepoint',
          'commit',
          'release',
        ]);
      });

      it('rolls back to the savepoint and rethrows, and the transaction goes on', async () => {
        const failure = new Error('rejected');
        const outcome = await db.tx(async (sql) => {
          const caught = await sql.savepoint(() => Promise.reject(failure)).catch((e: unknown) => e);
          await sql.query('UPDATE after');
          return caught;
        });
        expect(outcome).toBe(failure);
        expect(runner.calls).toEqual([
          'connect',
          'begin',
          'savepoint',
          'rollback to savepoint',
          'query UPDATE after',
          'commit',
          'release',
        ]);
      });

      it('throws the failure to roll back to the savepoint as the cause, keeping the original error', async () => {
        const failure = new Error('rejected');
        const lost = new Error('Connection terminated unexpectedly');
        runner.rollbackTransaction.mockRejectedValueOnce(lost);
        const caught = await db.tx((sql) => sql.savepoint(() => Promise.reject(failure))).catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(SavepointRollbackError);
        expect(caught).toMatchObject({
          message: 'Rollback to savepoint failed after "rejected": Connection terminated unexpectedly',
          cause: lost,
          original: failure,
        });
        // A lost connection while rolling back is a moment's failure, not the mutation's.
        expect(isTransient(caught)).toBe(true);
        expect(runner.release).toHaveBeenCalled();
      });
    });

    it('releases the runner when it cannot connect', async () => {
      runner.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(db.tx(() => Promise.resolve())).rejects.toThrow('ECONNREFUSED');
      expect(runner.startTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    function migrationsTable(present: boolean, applied: string[]) {
      dataSource.query.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('to_regclass') ? [{ present }] : applied.map((name) => ({ name }))),
      );
    }

    it('refuses to start while migrations are pending, naming them and the command', async () => {
      migrationsTable(false, []);
      await expect(db.onModuleInit()).rejects.toThrow(
        'The database schema is not up to date (pending migrations: InitialSchema1795564800000). ' +
          'Run "npm run migrate" before starting the server.',
      );
    });

    it('starts on an up-to-date schema without seeding by default', async () => {
      migrationsTable(true, ['InitialSchema1795564800000']);
      await db.onModuleInit();
      expect(runner.query).not.toHaveBeenCalled();
    });

    it('seeds the demo data when SEED_DEMO is true', async () => {
      migrationsTable(true, ['InitialSchema1795564800000']);
      settings.SEED_DEMO = true;
      db = await build();
      await db.onModuleInit();
      const statements = runner.query.mock.calls.map(([sql]) => sql);
      expect(statements).toEqual([
        expect.stringContaining('INSERT INTO sites'),
        expect.stringContaining('INSERT INTO users'),
        expect.stringContaining('INSERT INTO user_sites'),
      ]);
    });
  });
});
