import { clearCachedPublicBootstrap } from './publicBootstrap';
import { normalizePublicClientPatch, patchCachedPublicBootstrapClients } from './publicBootstrap';
import { broadcastCrossTab, subscribeCrossTab } from './crossTabEvents';
import { removeLocalStorageItem } from './browserStorage';
import { clearCachedPublicSettings } from './publicSettings';

export const PUBLIC_DATA_UPDATED_EVENT = 'cf-monitor:public-data-updated';
export const PUBLIC_DATA_READY_EVENT = 'cf-monitor:public-data-ready';

// Older versions persisted entire admin updates here; the key is only a transport envelope.
removeLocalStorageItem(PUBLIC_DATA_UPDATED_EVENT);

const subscribers = new Set<(detail?: PublicDataUpdateDetail) => void>();
let stopTransport: (() => void) | null = null;

export type PublicDataUpdateDetail = {
  force?: boolean;
  clients?: {
    upsert?: unknown[];
    remove?: string[];
  };
};

export function notifyPublicDataUpdated(detail?: PublicDataUpdateDetail) {
  const safeDetail = sanitizePublicDataUpdate(detail);
  if (subscribers.size === 0) applyPublicDataUpdate(safeDetail);
  broadcastCrossTab(PUBLIC_DATA_UPDATED_EVENT, safeDetail);
}

function applyPublicDataUpdate(detail?: PublicDataUpdateDetail): void {
  if (detail?.clients) patchCachedPublicBootstrapClients(detail);
  else {
    clearCachedPublicBootstrap();
    clearCachedPublicSettings();
  }
}

function sanitizePublicDataUpdate(detail?: PublicDataUpdateDetail): PublicDataUpdateDetail | undefined {
  if (!detail) return undefined;
  if (!detail.clients) return detail.force ? { force: true } : undefined;
  const remove = new Set((Array.isArray(detail.clients.remove) ? detail.clients.remove : [])
    .filter((uuid): uuid is string => typeof uuid === 'string' && uuid.trim() !== ''));
  const upsert = [];
  for (const raw of Array.isArray(detail.clients.upsert) ? detail.clients.upsert : []) {
    const client = normalizePublicClientPatch(raw);
    if (!client) continue;
    // Consumers have different visibility: refresh their own authorized view
    // instead of sending hidden metadata or removing it from an admin's list.
    if (client.hidden) return { force: true };
    upsert.push(client);
  }
  return { ...(detail.force ? { force: true } : {}), clients: { upsert, remove: [...remove] } };
}

export function notifyPublicDataReady() {
  window.dispatchEvent(new CustomEvent(PUBLIC_DATA_READY_EVENT));
}

export function subscribePublicDataUpdated(callback: (detail?: PublicDataUpdateDetail) => void) {
  subscribers.add(callback);
  if (!stopTransport) {
    stopTransport = subscribeCrossTab(PUBLIC_DATA_UPDATED_EVENT, (raw) => {
      const detail = sanitizePublicDataUpdate(raw as PublicDataUpdateDetail | undefined);
      // Invalidate once before all consumers fetch, so their requests can coalesce.
      applyPublicDataUpdate(detail);
      for (const subscriber of [...subscribers]) subscriber(detail);
    });
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) { stopTransport?.(); stopTransport = null; }
  };
}
