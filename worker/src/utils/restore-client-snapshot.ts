import { isPublicIpAddress } from './request-ip';

const SNAPSHOT_KEY = 'admin-clients:snapshot';
const SQLITE_VALUE_LIMIT_BYTES = 2 * 1024 * 1024;
// Leave space for structured-clone encoding and subsequent small metadata edits.
const SERIALIZATION_MARGIN_BYTES = 256 * 1024;
// Backup rows may omit columns supplied by the database (timestamps, empty
// descriptive fields and token-use diagnostics). Reserve these before SQL runs.
const DATABASE_DEFAULTS_BYTES_PER_CLIENT = 512;

export function restoredClientMetadata(client: object): Record<string, unknown> & { uuid: string } {
  const safe = Object.fromEntries(Object.entries(client).filter(([key]) => key !== 'token' && key !== 'token_hash'));
  const uuid = typeof safe.uuid === 'string' ? safe.uuid.trim() : '';
  for (const field of ['ipv4', 'ipv6'] as const) {
    const value = safe[field];
    if (typeof value === 'string' && value.trim() && !isPublicIpAddress(value)) safe[field] = '';
    safe[`has_${field}`] = isPublicIpAddress(String(safe[field] || ''));
  }
  return { ...safe, uuid };
}

export function measureRestoredClientSnapshot(clients: readonly object[], reserveDatabaseDefaults = true) {
  const metadata = clients.map(restoredClientMetadata);
  const snapshot = { clients: metadata, updatedAt: Number.MAX_SAFE_INTEGER, removed: [], complete: true };
  const serializedBytes = new TextEncoder().encode(SNAPSHOT_KEY + JSON.stringify(snapshot)).byteLength;
  const estimatedBytes = serializedBytes + (reserveDatabaseDefaults ? metadata.length * DATABASE_DEFAULTS_BYTES_PER_CLIENT : 0);
  const maximumBytes = SQLITE_VALUE_LIMIT_BYTES - SERIALIZATION_MARGIN_BYTES;
  return { fits: estimatedBytes <= maximumBytes, estimatedBytes, maximumBytes };
}
