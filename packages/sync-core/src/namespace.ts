/** Every client database's name starts with this; the rest is the user's namespace. */
export const DATABASE_PREFIX = 'fieldsync-';

/**
 * The name of the database of the user a token belongs to: the prefix and the SHA-256 of the token,
 * in hex. Each user (each token) gets a database of their own, so nobody signing in after another
 * user of the browser sees that user's rows or sends under their client id (F-40). The name works
 * offline from the first sign-in, and does not contain the token.
 */
export async function databaseNameFor(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${DATABASE_PREFIX}${hex}`;
}

/**
 * Deletes every client database of this origin (signing out, or a start with nobody signed in,
 * which also finishes a sign-out a closed page interrupted). Open connections in other tabs get
 * `versionchange` and close (see `IdbSyncStorage`), so the deletion is not kept waiting.
 */
export async function deleteSyncDatabases(factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  const databases = await factory.databases();
  await Promise.all(
    databases
      .map((db) => db.name)
      .filter((name): name is string => name?.startsWith(DATABASE_PREFIX) ?? false)
      .map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const request = factory.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error(`deleting ${name} failed`));
          }),
      ),
  );
}
