import type { LiveDataResponse } from '../contexts/LiveDataContext';
import { normalizeLiveDataResponse } from './liveDataResponse.ts';
import { normalizePublicClients } from './publicClients.ts';
import { normalizePublicSettings, type PublicSettings } from './publicSettings.ts';
import { fetchWithBootstrapRetry } from './api.ts';
import type { ClientInfo } from '../types';
import { getLocalStorageItem, removeLocalStorageItem, setLocalStorageItem } from './browserStorage.ts';

export interface PublicBootstrapPayload {
  settings?: PublicSettings;
  clients?: ClientInfo[];
  nodes?: ClientInfo[];
  live?: LiveDataResponse | null;
  metadata_version?: string;
  snapshot_at?: number;
  server_time?: number;
}

let bootstrapPromise: Promise<PublicBootstrapPayload> | null = null;
let bootstrapCache: PublicBootstrapPayload | null = null;
let clientPatchCache: PublicBootstrapClientPatch | null = null;
const PUBLIC_BOOTSTRAP_STORAGE_KEY = 'cf_monitor_public_bootstrap';
const PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY = 'cf_monitor_public_bootstrap_client_patch';
const PUBLIC_BOOTSTRAP_STORAGE_MAX_AGE_MS = 10 * 60_000;
const PUBLIC_BOOTSTRAP_CLIENT_PATCH_MAX_AGE_MS = 10 * 60_000;

type PublicBootstrapClientPatch = {
  saved_at: number;
  upsert: ClientInfo[];
  remove: string[];
};

export type PublicBootstrapClientPatchDetail = {
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

function normalizePublicBootstrap(payload: unknown): PublicBootstrapPayload {
  const record = asRecord(payload);
  if (!record) throw new Error('Invalid public bootstrap response');
  return applyStoredClientPatch({
    settings: record.settings === undefined ? undefined : normalizePublicSettings(record.settings) || undefined,
    clients: record.clients === undefined ? undefined : normalizePublicClients(record.clients),
    nodes: record.nodes === undefined ? undefined : normalizePublicClients(record.nodes),
    live: record.live === undefined ? undefined : normalizeLiveDataResponse(record.live),
    metadata_version: typeof record.metadata_version === 'string' ? record.metadata_version : undefined,
    snapshot_at: typeof record.snapshot_at === 'number' && Number.isFinite(record.snapshot_at) ? record.snapshot_at : undefined,
    server_time: typeof record.server_time === 'number' && Number.isFinite(record.server_time) ? record.server_time : undefined,
  });
}

function readClientPatch(): PublicBootstrapClientPatch | null {
  if (clientPatchCache && Date.now() - clientPatchCache.saved_at <= PUBLIC_BOOTSTRAP_CLIENT_PATCH_MAX_AGE_MS) {
    return clientPatchCache;
  }
  try {
    const raw = getLocalStorageItem(PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<PublicBootstrapClientPatch>;
    if (!stored.saved_at || Date.now() - stored.saved_at > PUBLIC_BOOTSTRAP_CLIENT_PATCH_MAX_AGE_MS) return null;
    clientPatchCache = {
      saved_at: stored.saved_at,
      upsert: normalizePublicClients(stored.upsert),
      remove: Array.isArray(stored.remove)
        ? stored.remove.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
        : [],
    };
    return clientPatchCache;
  } catch {
    return null;
  }
}

function writeClientPatch(patch: PublicBootstrapClientPatch): void {
  clientPatchCache = patch;
  setLocalStorageItem(PUBLIC_BOOTSTRAP_CLIENT_PATCH_KEY, JSON.stringify(patch));
}

function clientPatchFromDetail(detail?: PublicBootstrapClientPatchDetail): Omit<PublicBootstrapClientPatch, 'saved_at'> | null {
  const rawUpserts = Array.isArray(detail?.clients?.upsert) ? detail.clients.upsert : [];
  const remove = new Set(Array.isArray(detail?.clients?.remove) ? detail.clients.remove : []);
  for (const raw of rawUpserts) {
    const record = asRecord(raw);
    const uuid = typeof record?.uuid === 'string' ? record.uuid.trim() : '';
    if (uuid && record?.hidden === true) remove.add(uuid);
  }
  const upsert = normalizePublicClients(rawUpserts);
  if (upsert.length === 0 && remove.size === 0) return null;
  return { upsert, remove: [...remove] };
}

function mergeClientPatch(next: Omit<PublicBootstrapClientPatch, 'saved_at'>): PublicBootstrapClientPatch {
  const previous = readClientPatch();
  const remove = new Set(previous?.remove || []);
  const byUuid = new Map((previous?.upsert || []).map(client => [client.uuid, client]));
  for (const uuid of next.remove) {
    remove.add(uuid);
    byUuid.delete(uuid);
  }
  for (const client of next.upsert) {
    remove.delete(client.uuid);
    byUuid.set(client.uuid, client);
  }
  return { saved_at: Date.now(), upsert: [...byUuid.values()], remove: [...remove] };
}

function applyClientPatch(clients: ClientInfo[] | undefined, patch: PublicBootstrapClientPatch | null): ClientInfo[] | undefined {
  if (!clients || !patch) return clients;
  const remove = new Set(patch.remove);
  const byUuid = new Map(
    clients
      .filter(client => !remove.has(client.uuid))
      .map(client => [client.uuid, client]),
  );
  for (const client of patch.upsert) {
    const existing = byUuid.get(client.uuid);
    const next = { ...existing, ...client };
    if (existing) {
      for (const [key, value] of Object.entries(client)) {
        if (typeof value === 'string' && value === '' && typeof existing[key as keyof ClientInfo] === 'string' && existing[key as keyof ClientInfo]) {
          (next as Record<string, unknown>)[key] = existing[key as keyof ClientInfo];
        }
      }
      if (client.price === 0 && existing.price !== 0) next.price = existing.price;
      if (client.billing_cycle === 0 && existing.billing_cycle !== 0) next.billing_cycle = existing.billing_cycle;
    }
    byUuid.set(client.uuid, next);
  }
  return [...byUuid.values()];
}

function applyStoredClientPatch(payload: PublicBootstrapPayload): PublicBootstrapPayload {
  const patch = readClientPatch();
  return patch
    ? { ...payload, clients: applyClientPatch(payload.clients, patch), nodes: applyClientPatch(payload.nodes, patch) }
    : payload;
}

function savePublicBootstrap(payload: PublicBootstrapPayload): PublicBootstrapPayload {
  bootstrapCache = payload;
  setLocalStorageItem(PUBLIC_BOOTSTRAP_STORAGE_KEY, JSON.stringify({ saved_at: Date.now(), payload }));
  return payload;
}

export function getCachedPublicBootstrap(): PublicBootstrapPayload | null {
  if (bootstrapCache) return bootstrapCache;
  try {
    const raw = getLocalStorageItem(PUBLIC_BOOTSTRAP_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { saved_at?: number; payload?: unknown };
    if (!stored.saved_at || Date.now() - stored.saved_at > PUBLIC_BOOTSTRAP_STORAGE_MAX_AGE_MS) return null;
    bootstrapCache = normalizePublicBootstrap(stored.payload);
    return bootstrapCache;
  } catch {
    return null;
  }
}

export function clearCachedPublicBootstrap(): void {
  bootstrapCache = null;
  removeLocalStorageItem(PUBLIC_BOOTSTRAP_STORAGE_KEY);
}

export function patchCachedPublicBootstrapClients(detail?: PublicBootstrapClientPatchDetail): void {
  const patch = clientPatchFromDetail(detail);
  if (!patch) return;
  const merged = mergeClientPatch(patch);
  writeClientPatch(merged);
  const cached = getCachedPublicBootstrap();
  if (cached) savePublicBootstrap(applyStoredClientPatch(cached));
}

export async function fetchPublicBootstrap(options: { cache?: RequestCache; cacheBust?: boolean } = {}): Promise<PublicBootstrapPayload> {
  if (bootstrapPromise && !options.cacheBust) return bootstrapPromise;
  const url = new URL('/api/public/bootstrap', typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  if (options.cacheBust) url.searchParams.set('_fresh', String(Date.now()));
  const promise = fetchWithBootstrapRetry(`${url.pathname}${url.search}`, options.cache ? { cache: options.cache } : undefined)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((payload) => {
      const normalized = normalizePublicBootstrap(payload);
      return savePublicBootstrap(normalized);
    })
    .finally(() => {
      if (bootstrapPromise === promise) bootstrapPromise = null;
    });
  bootstrapPromise = promise;
  return bootstrapPromise;
}
