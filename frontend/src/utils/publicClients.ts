import type { ClientInfo } from '../types';

export type PublicClientPatchDetail = {
  clients?: {
    upsert?: unknown[];
    remove?: string[];
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanField(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function listItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  return Array.isArray(record?.data) ? record.data : [];
}

export function normalizePublicClient(payload: unknown): ClientInfo | null {
  const record = asRecord(payload);
  const uuid = typeof record?.uuid === 'string' ? record.uuid.trim() : '';
  if (!record || !uuid) return null;
  const name = stringField(record, 'name').trim() || uuid;

  return {
    uuid,
    name,
    cpu_name: stringField(record, 'cpu_name'),
    cpu_cores: numberField(record, 'cpu_cores'),
    os: stringField(record, 'os'),
    arch: stringField(record, 'arch'),
    has_ipv4: booleanField(record, 'has_ipv4'),
    has_ipv6: booleanField(record, 'has_ipv6'),
    region: stringField(record, 'region'),
    mem_total: numberField(record, 'mem_total'),
    swap_total: numberField(record, 'swap_total'),
    disk_total: numberField(record, 'disk_total'),
    group: stringField(record, 'group'),
    tags: stringField(record, 'tags'),
    hidden: booleanField(record, 'hidden'),
    price: numberField(record, 'price'),
    billing_cycle: numberField(record, 'billing_cycle'),
    currency: stringField(record, 'currency'),
    expired_at: stringField(record, 'expired_at'),
    traffic_limit: numberField(record, 'traffic_limit'),
    traffic_limit_type: stringField(record, 'traffic_limit_type'),
    sort_order: numberField(record, 'sort_order'),
    gpu_name: stringField(record, 'gpu_name'),
    version: stringField(record, 'version'),
    public_remark: stringField(record, 'public_remark'),
    virtualization: stringField(record, 'virtualization'),
    kernel_version: stringField(record, 'kernel_version'),
  };
}

export function normalizePublicClients(payload: unknown, options: { includeHidden?: boolean } = {}): ClientInfo[] {
  return sortPublicClients(listItems(payload).flatMap((item) => {
    const client = normalizePublicClient(item);
    return client && (options.includeHidden || !client.hidden) ? [client] : [];
  }));
}

export function sortPublicClients(clients: ClientInfo[]): ClientInfo[] {
  return [...clients].sort((a, b) => {
    const aOrder = Number.isFinite(a.sort_order) ? Number(a.sort_order) : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.sort_order) ? Number(b.sort_order) : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || (a.name || '').localeCompare(b.name || '') || a.uuid.localeCompare(b.uuid);
  });
}

export function mergePublicClientPatch(
  current: ClientInfo[],
  detail?: PublicClientPatchDetail,
  options: { includeHidden?: boolean } = {},
): ClientInfo[] {
  const clientDelta = detail?.clients;
  if (!clientDelta) return current;

  const remove = new Set(Array.isArray(clientDelta.remove) ? clientDelta.remove : []);
  const byUuid = new Map(
    current
      .filter((client) => !remove.has(client.uuid))
      .map((client) => [client.uuid, client]),
  );

  for (const raw of Array.isArray(clientDelta.upsert) ? clientDelta.upsert : []) {
    const record = asRecord(raw);
    const uuid = typeof record?.uuid === 'string' ? record.uuid.trim() : '';
    if (!record || !uuid) continue;
    if (!options.includeHidden && booleanField(record, 'hidden')) {
      byUuid.delete(uuid);
      remove.add(uuid);
      continue;
    }

    const normalized = normalizePublicClient(record);
    if (!normalized || (!options.includeHidden && normalized.hidden)) continue;

    const existing = byUuid.get(uuid);
    if (!existing) {
      byUuid.set(uuid, normalized);
      remove.delete(uuid);
      continue;
    }

    const next: ClientInfo = { ...existing };
    const nextRecord = next as unknown as Record<string, unknown>;
    for (const key of Object.keys(normalized) as Array<keyof ClientInfo>) {
      if (key === 'uuid' || Object.prototype.hasOwnProperty.call(record, key)) {
        nextRecord[key] = normalized[key];
      }
    }
    byUuid.set(uuid, next);
    remove.delete(uuid);
  }

  return sortPublicClients([...byUuid.values()]);
}
