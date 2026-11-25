import { GcService } from '../../src/gc.service';
import { startApp, type RunningApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { describeWithDb } from '../support/integration';

describeWithDb('configuration at startup', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database?.drop());

  it('refuses to start with a non-numeric GC interval instead of collecting every millisecond', async () => {
    const collect = jest.spyOn(GcService.prototype, 'collect');
    let server: RunningApp | undefined;
    let error: unknown;
    let collectCalls = 0;
    try {
      server = await startApp(database.url, { GC_INTERVAL_MS: '1h' });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      error = err;
    } finally {
      collectCalls = collect.mock.calls.length;
      await server?.close();
      collect.mockRestore();
    }
    expect({ collectCallsWithin100ms: collectCalls, error: String(error) }).toEqual({
      collectCallsWithin100ms: 0,
      error: expect.stringContaining('GC_INTERVAL_MS'),
    });
  });
});
