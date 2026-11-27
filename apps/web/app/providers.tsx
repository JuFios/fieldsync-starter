'use client';

// The shared mutators check strings with String.prototype.isWellFormed (ES2024), which browsers that
// Next.js 14 supports by default (Safari 12+, Chrome 64+) may lack. Next.js does not polyfill it, so
// the specific polyfill is imported here, before the sync client is created.
import 'core-js/stable/string/is-well-formed';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { HttpTransport, IdbSyncStorage, localStorageLegacy, SyncClient } from '@fieldsync/sync-core';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const ClientContext = createContext<SyncClient | null>(null);

/** The database of the client's state; one for the browser, as the original client's localStorage was. */
const DATABASE = 'fieldsync';

export function Providers({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SyncClient | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem('fs_token'));
  }, []);

  useEffect(() => {
    if (!token) return;
    // The original client's id and last mutation id move from localStorage into the database.
    void IdbSyncStorage.open(DATABASE, { legacy: localStorageLegacy(localStorage) }).then((storage) => {
      const c = new SyncClient({ transport: new HttpTransport(API, token), storage });
      setClient(c);
      void c.sync();
      const es = new EventSource(`${API}/sync/stream?token=${encodeURIComponent(token)}`);
      es.addEventListener('poke', () => void c.sync());
    });
  }, [token]);

  if (!token) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get('token');
          if (typeof value === 'string' && value) {
            localStorage.setItem('fs_token', value);
            setToken(value);
          }
        }}
      >
        <h1>FieldSync</h1>
        <p>Enter an access token (demo: admin-token, tech-a-token, tech-b-token).</p>
        <input name="token" placeholder="token" />
        <button type="submit">Sign in</button>
      </form>
    );
  }

  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useSyncClient(): SyncClient | null {
  return useContext(ClientContext);
}

/** Re-renders whenever the client state changes. */
export function useSyncState(client: SyncClient | null): number {
  return useSyncExternalStore(
    (cb) => (client ? client.subscribe(cb) : () => undefined),
    () => (client ? client.snapshotVersion : 0),
    () => 0,
  );
}
