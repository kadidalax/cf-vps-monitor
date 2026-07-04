import type { LiveDataResponse } from '../contexts/LiveDataContext';

export type ViewerTokenResponse = {
  token: string;
  expires_at: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function emptyLiveDataResponse(now = Date.now()): LiveDataResponse {
  return { online: [], clients: [], data: {}, count: 0, timestamp: now };
}

export function normalizeLiveDataResponse(payload: unknown): LiveDataResponse | null {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.online) || !record.online.every(item => typeof item === 'string')) {
    return null;
  }
  const count = asFiniteNumber(record.count);
  if (count === null || count < 0) return null;
  const clients = Array.isArray(record.clients)
    ? record.clients.flatMap((client) => {
        const entry = asRecord(client);
        if (!entry || typeof entry.uuid !== 'string' || typeof entry.name !== 'string') return [];
        const lastReportTime = asFiniteNumber(entry.lastReportTime);
        if (lastReportTime === null) return [];
        return [{ ...entry, uuid: entry.uuid, name: entry.name, lastReportTime }];
      }) as LiveDataResponse['clients']
    : [];
  const data = asRecord(record.data);
  const metadataVersion = typeof record.metadata_version === 'string' && record.metadata_version.trim() !== ''
    ? record.metadata_version
    : undefined;
  return {
    online: record.online,
    clients,
    data: data as LiveDataResponse['data'] || {},
    count: Math.floor(count),
    timestamp: asFiniteNumber(record.timestamp) ?? Date.now(),
    ...(metadataVersion ? { metadata_version: metadataVersion } : {}),
  };
}

export function normalizeViewerTokenResponse(payload: unknown): ViewerTokenResponse | null {
  const record = asRecord(payload);
  if (!record || typeof record.token !== 'string' || record.token.trim() === '') return null;
  return {
    token: record.token,
    expires_at: typeof record.expires_at === 'number' && Number.isFinite(record.expires_at)
      ? record.expires_at
      : null,
  };
}
