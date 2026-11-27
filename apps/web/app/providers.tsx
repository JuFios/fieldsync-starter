'use client';

// The shared mutators check strings with String.prototype.isWellFormed (ES2024), which browsers that
// Next.js 14 supports by default (Safari 12+, Chrome 64+) may lack. Next.js does not polyfill it, so
// the specific polyfill is imported here, before the sync client is created.
import 'core-js/stable/string/is-well-formed';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  BrowserTabs,
  databaseNameFor,
  deleteSyncDatabases,
  HttpTransport,
  IdbSyncStorage,
  localStorageLegacy,
  SyncClient,
  type StorageClosedReason,
} from '@fieldsync/sync-core';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'fs_token';

const ClientContext = createContext<SyncClient | null>(null);

/**
 * Why the app cannot work right now, other than being signed out. `blocked` passes: the other tab
 * keeps an older local schema open, and the app goes on once it is closed.
 */
type Problem = 'storage' | 'superseded' | 'blocked';

export function Providers({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SyncClient | null>(null);
  // Undefined until localStorage was read (it exists only in the browser).
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
  }, []);

  useEffect(() => {
    if (token === undefined) return;
    if (token === null) {
      // Nobody is signed in: no user's data may stay in the browser. This also finishes a sign-out
      // that a closed page interrupted after removing the token.
      void deleteSyncDatabases().catch(() => setProblem('storage'));
      return;
    }
    // Everything this effect starts is stopped by its cleanup: on unmount, and before it runs again
    // for another token. Opening is asynchronous, so a cleanup that comes first is remembered and the
    // late result closed at once.
    let stopped = false;
    let opened: { client: SyncClient; storage: IdbSyncStorage } | undefined;
    const unblocked = () => setProblem((current) => (current === 'blocked' ? null : current));
    const onOnline = () => void opened?.client.sync();
    const onClosed = (reason: StorageClosedReason) => {
      if (stopped) return;
      if (reason === 'deleted') {
        // Signed out in another tab: that tab removed the token and deletes the database.
        setToken(null);
      } else {
        setProblem(reason === 'superseded' ? 'superseded' : 'storage');
      }
    };
    void (async () => {
      try {
        // One database per user (F-40). The original client's id and last mutation id move into it
        // from localStorage, where the token signed in now was stored next to them.
        const name = await databaseNameFor(token);
        const storage = await IdbSyncStorage.open(name, {
          legacy: localStorageLegacy(localStorage),
          onClosed,
          onBlocked: () => {
            if (!stopped) setProblem('blocked');
          },
        });
        // The open is through; a newer app may have closed the database again meanwhile.
        unblocked();
        if (stopped) {
          storage.close();
          return;
        }
        // Ask the browser not to evict the queue under storage pressure (it decides; Firefox asks
        // the user). Best-effort storage keeps working without it.
        void navigator.storage?.persist?.().catch(() => false);
        // The user's tabs share the database; the one that leads talks to the server and keeps the
        // notification stream open (with the token in a header), the others follow it.
        const c = new SyncClient({ transport: new HttpTransport(API, token), storage, tabs: new BrowserTabs(name) });
        opened = { client: c, storage };
        setClient(c);
        void c.sync();
        // Back online: sync now instead of waiting for the backoff delay.
        window.addEventListener('online', onOnline);
      } catch {
        // IndexedDB unavailable (some private modes) or refused: the app cannot keep any work.
        if (!stopped) setProblem('storage');
      }
    })();
    return () => {
      stopped = true;
      unblocked();
      window.removeEventListener('online', onOnline);
      setClient(null);
      if (opened) {
        opened.client.dispose();
        opened.storage.close();
      }
    };
  }, [token]);

  const signOut = useCallback(() => {
    const unsynced = client?.pendingCount ?? 0;
    if (unsynced > 0 && !window.confirm(`${unsynced} changes are not synced yet and will be lost. Sign out?`)) {
      return;
    }
    // The token goes first: a page closed before the deletion finishes deletes the data on its next
    // start, since nobody is signed in then. The effect's cleanup closes this tab's database; other
    // tabs close theirs when the deletion asks them to.
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, [client]);

  if (problem === 'storage') {
    return <p role="alert">This browser does not let FieldSync keep data on this device, so it cannot work offline.</p>;
  }
  if (problem === 'blocked') {
    return <p role="alert">FieldSync is open in another tab with an older version. Close it to continue.</p>;
  }
  if (problem === 'superseded') {
    return <p role="alert">A newer version of FieldSync is open in another tab. Reload this page to continue.</p>;
  }
  if (token === undefined) return null;
  if (token === null) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get('token');
          if (typeof value === 'string' && value) {
            localStorage.setItem(TOKEN_KEY, value);
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

  return (
    <ClientContext.Provider value={client}>
      <div style={{ textAlign: 'right' }}>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
      {children}
    </ClientContext.Provider>
  );
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
