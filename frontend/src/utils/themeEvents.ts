export const THEME_UPDATED_EVENT = 'cf-monitor:theme-updated';

const CHANNEL_NAME = THEME_UPDATED_EVENT;

export function notifyThemeUpdated() {
  window.dispatchEvent(new CustomEvent(THEME_UPDATED_EVENT));
  try {
    localStorage.setItem(THEME_UPDATED_EVENT, String(Date.now()));
  } catch {}
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: THEME_UPDATED_EVENT });
    channel.close();
  } catch {}
}

export function subscribeThemeUpdated(callback: () => void) {
  const onLocalEvent = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_UPDATED_EVENT) callback();
  };
  let channel: BroadcastChannel | null = null;

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      if (event.data?.type === THEME_UPDATED_EVENT) callback();
    };
  } catch {}

  window.addEventListener(THEME_UPDATED_EVENT, onLocalEvent);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(THEME_UPDATED_EVENT, onLocalEvent);
    window.removeEventListener('storage', onStorage);
    channel?.close();
  };
}
