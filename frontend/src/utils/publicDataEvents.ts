import { clearCachedPublicBootstrap } from './publicBootstrap';
import { patchCachedPublicBootstrapClients } from './publicBootstrap';

export const PUBLIC_DATA_UPDATED_EVENT = 'cf-monitor:public-data-updated';
export const PUBLIC_DATA_READY_EVENT = 'cf-monitor:public-data-ready';

const CHANNEL_NAME = PUBLIC_DATA_UPDATED_EVENT;
const EMPTY_UPDATE_SUPPRESS_MS = 10_000;
let lastDetailedUpdateAt = 0;

export type PublicDataUpdateDetail = {
  force?: boolean;
  clients?: {
    upsert?: unknown[];
    remove?: string[];
  };
};

export function notifyPublicDataUpdated(detail?: PublicDataUpdateDetail) {
  rememberDetailedUpdate(detail);
  if (detail?.clients) patchCachedPublicBootstrapClients(detail);
  else clearCachedPublicBootstrap();
  window.dispatchEvent(new CustomEvent(PUBLIC_DATA_UPDATED_EVENT, { detail }));
  try {
    localStorage.setItem(PUBLIC_DATA_UPDATED_EVENT, JSON.stringify({ at: Date.now(), detail }));
  } catch {}
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: PUBLIC_DATA_UPDATED_EVENT, detail });
    channel.close();
  } catch {}
}

function rememberDetailedUpdate(detail?: PublicDataUpdateDetail) {
  if (detail?.clients) lastDetailedUpdateAt = Date.now();
}

function shouldIgnoreEmptyUpdate(detail?: PublicDataUpdateDetail): boolean {
  if (detail?.force) return false;
  return !detail?.clients && Date.now() - lastDetailedUpdateAt < EMPTY_UPDATE_SUPPRESS_MS;
}

export function notifyPublicDataReady() {
  window.dispatchEvent(new CustomEvent(PUBLIC_DATA_READY_EVENT));
}

export function subscribePublicDataUpdated(callback: (detail?: PublicDataUpdateDetail) => void) {
  const onLocalEvent = (event: Event) => {
    const detail = event instanceof CustomEvent ? event.detail : undefined;
    rememberDetailedUpdate(detail);
    if (!shouldIgnoreEmptyUpdate(detail)) callback(detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PUBLIC_DATA_UPDATED_EVENT) return;
    try {
      const parsed = event.newValue ? JSON.parse(event.newValue) : null;
      rememberDetailedUpdate(parsed?.detail);
      if (!shouldIgnoreEmptyUpdate(parsed?.detail)) callback(parsed?.detail);
    } catch {
      if (!shouldIgnoreEmptyUpdate()) callback();
    }
  };
  let channel: BroadcastChannel | null = null;

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      if (event.data?.type !== PUBLIC_DATA_UPDATED_EVENT) return;
      rememberDetailedUpdate(event.data.detail);
      if (!shouldIgnoreEmptyUpdate(event.data.detail)) callback(event.data.detail);
    };
  } catch {}

  window.addEventListener(PUBLIC_DATA_UPDATED_EVENT, onLocalEvent);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(PUBLIC_DATA_UPDATED_EVENT, onLocalEvent);
    window.removeEventListener('storage', onStorage);
    channel?.close();
  };
}
