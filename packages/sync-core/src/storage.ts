import type { Row } from './types';

export interface Persisted {
  cursor: number;
  lastMutationId: number;
  base: Record<string, Row>;
}

/**
 * Where a client keeps its state between page loads. Asynchronous, as browser storage that can hold
 * a client's data (IndexedDB) is.
 */
export interface SyncStorage {
  load(): Promise<Persisted | null>;
  save(state: Persisted): Promise<void>;
}

export class MemoryStorage implements SyncStorage {
  private state: Persisted | null = null;

  load(): Promise<Persisted | null> {
    return Promise.resolve(this.state ? structuredClone(this.state) : null);
  }

  save(state: Persisted): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

export class LocalStorageSyncStorage implements SyncStorage {
  constructor(private readonly key: string) {}

  load(): Promise<Persisted | null> {
    try {
      const raw = globalThis.localStorage.getItem(this.key);
      return Promise.resolve(raw ? (JSON.parse(raw) as Persisted) : null);
    } catch {
      return Promise.resolve(null);
    }
  }

  save(state: Persisted): Promise<void> {
    try {
      globalThis.localStorage.setItem(this.key, JSON.stringify(state));
    } catch {
      // Storage may be full or unavailable; the client keeps working in memory.
    }
    return Promise.resolve();
  }
}
