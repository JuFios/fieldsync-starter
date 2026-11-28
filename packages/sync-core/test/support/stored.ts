import { asLastMutationId, asMutationId, asVersion, type MemoryStorage, type Row } from '../../src';

/**
 * Puts a state into a memory storage, as a client that synced before left it: a cursor, the last
 * handled mutation id and the server's rows. MemoryStorage applies a commit before it returns, so a
 * client created right after loads this state.
 */
export function storeState(
  storage: MemoryStorage,
  state: { cursor: number; lastMutationId: number; base: Record<string, Row> },
): void {
  void storage.commit({
    meta: {
      cursor: asVersion(state.cursor),
      lastMutationId: asLastMutationId(state.lastMutationId),
      nextMutationIdAtLeast: asMutationId(state.lastMutationId + 1),
    },
    base: { put: Object.entries(state.base) },
  });
}
