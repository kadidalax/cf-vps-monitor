export interface AuditLogEntry {
  user?: string | null;
  id: number;
  action?: string | null;
  detail?: unknown;
  level?: string | null;
  time: string;
}

export interface AuditLogsPage {
  logs: AuditLogEntry[];
  total: number;
  hasMore: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeAuditLogEntry(value: unknown): AuditLogEntry | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = finiteNumber(record.id);
  const time = optionalString(record.time);
  if (id === null || !time) return null;

  return {
    id,
    time,
    user: optionalString(record.user),
    action: optionalString(record.action),
    detail: record.detail ?? null,
    level: optionalString(record.level),
  };
}

export function normalizeAuditLogsPage(payload: unknown): AuditLogsPage {
  const record = asRecord(payload);
  if (!record) return { logs: [], total: 0, hasMore: false };

  const logs = Array.isArray(record.data)
    ? record.data.map(normalizeAuditLogEntry).filter((entry): entry is AuditLogEntry => entry !== null)
    : [];
  const total = finiteNumber(record.total) ?? logs.length;

  return {
    logs,
    total: Math.max(0, Math.trunc(total)),
    hasMore: record.has_more === true,
  };
}
