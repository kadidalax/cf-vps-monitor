export const WEBSITE_MONITORS_UPDATED_EVENT = 'cf-monitor:website-monitors-updated';

const CHANNEL_NAME = WEBSITE_MONITORS_UPDATED_EVENT;

export type WebsiteMonitorsUpdateDetail = {
  upsert?: unknown[];
  remove?: number[];
  reorder?: number[];
};

export function notifyWebsiteMonitorsUpdated(detail?: WebsiteMonitorsUpdateDetail | true) {
  window.dispatchEvent(new CustomEvent(WEBSITE_MONITORS_UPDATED_EVENT, { detail }));
  try {
    localStorage.setItem(WEBSITE_MONITORS_UPDATED_EVENT, JSON.stringify({ at: Date.now(), detail }));
  } catch {}
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: WEBSITE_MONITORS_UPDATED_EVENT, detail });
    channel.close();
  } catch {}
}

export function subscribeWebsiteMonitorsUpdated(callback: (detail?: WebsiteMonitorsUpdateDetail | true) => void) {
  const onLocalEvent = (event: Event) => {
    callback(event instanceof CustomEvent ? event.detail : undefined);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== WEBSITE_MONITORS_UPDATED_EVENT) return;
    try {
      const parsed = event.newValue ? JSON.parse(event.newValue) : null;
      callback(parsed?.detail);
    } catch {
      callback();
    }
  };
  let channel: BroadcastChannel | null = null;

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      if (event.data?.type === WEBSITE_MONITORS_UPDATED_EVENT) callback(event.data.detail);
    };
  } catch {}

  window.addEventListener(WEBSITE_MONITORS_UPDATED_EVENT, onLocalEvent);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(WEBSITE_MONITORS_UPDATED_EVENT, onLocalEvent);
    window.removeEventListener('storage', onStorage);
    channel?.close();
  };
}
