'use client';

import type { SyncClient, SyncIndicator } from '@fieldsync/sync-core';
import { useSyncState } from './providers';

/** Words for the indicator (task 3.3.3); the full status UI comes with the frontend work. */
const LABELS: Record<SyncIndicator, string> = {
  synced: 'synced',
  pending: 'pending changes',
  offline: 'offline',
  rejected: 'rejected changes',
  loading: 'loading',
  error: 'cannot save on this device',
  'update-required': 'update required: reload the app',
};

export function StatusBar({ client }: { client: SyncClient }) {
  useSyncState(client);
  return (
    <div role="status" style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
      {LABELS[client.indicator]} · {client.pendingCount} pending
    </div>
  );
}
