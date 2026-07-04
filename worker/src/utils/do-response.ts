export type LiveSnapshot = {
  online: string[];
  clients?: Record<string, unknown>[];
  data?: Record<string, unknown>;
  count: number;
  timestamp?: number;
  metadata_version?: string;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter: number;
};

export type ClientReportResult = {
  persisted: boolean;
};

type RateLimitDefaults = {
  limit: number;
  remaining: number;
  reset?: number;
  retryAfter?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const value = await response.json().catch(() => null);
  return isRecord(value) ? value : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

export async function readLiveSnapshot(response: Response): Promise<LiveSnapshot | null> {
  const value = await readJsonObject(response);
  if (
    !value ||
    !Array.isArray(value.online) ||
    !value.online.every(item => typeof item === 'string') ||
    typeof value.count !== 'number' ||
    !Number.isFinite(value.count) ||
    value.count < 0
  ) return null;

  const snapshot: LiveSnapshot = {
    online: value.online,
    count: Math.floor(value.count),
  };
  if (Array.isArray(value.clients)) {
    snapshot.clients = value.clients.filter(isRecord);
  }
  if (isRecord(value.data)) {
    snapshot.data = value.data;
  }
  if (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)) {
    snapshot.timestamp = value.timestamp;
  }
  if (typeof value.metadata_version === 'string' && value.metadata_version.trim() !== '') {
    snapshot.metadata_version = value.metadata_version;
  }
  return snapshot;
}

export async function readClientReportResult(response: Response): Promise<ClientReportResult | null> {
  const value = await readJsonObject(response);
  if (!value || typeof value.persisted !== 'boolean') return null;
  return { persisted: value.persisted };
}

export async function readAcceptedCount(response: Response): Promise<number | null> {
  const value = await readJsonObject(response);
  if (!value) return null;
  const accepted = Number(value.accepted);
  return Number.isFinite(accepted) && accepted >= 0 ? Math.floor(accepted) : null;
}

export async function readRateLimitResult(
  response: Response,
  defaults: RateLimitDefaults,
): Promise<RateLimitResult | null> {
  const value = await readJsonObject(response);
  if (!value || typeof value.allowed !== 'boolean') return null;
  return {
    allowed: value.allowed,
    limit: Math.max(1, Math.floor(finiteNumber(value.limit, defaults.limit))),
    remaining: Math.max(0, Math.floor(finiteNumber(value.remaining, defaults.remaining))),
    reset: Math.ceil(finiteNumber(value.reset, defaults.reset ?? Date.now() / 1000)),
    retryAfter: Math.max(1, Math.ceil(finiteNumber(value.retry_after, defaults.retryAfter ?? 60))),
  };
}
