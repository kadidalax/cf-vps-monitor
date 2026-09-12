/**
 * 跨标签页事件广播。
 *
 * 此前 publicDataEvents / websiteMonitorEvents / themeEvents 三个模块各自复制了同一段逻辑：
 * 发送时**同时**写 localStorage 和 BroadcastChannel，接收时两条都监听。二者本意是互为
 * 降级备份，但现代浏览器两条都支持，于是同一条通知被投递两次、订阅回调被执行两遍。
 *
 * 实测（两个标签页，一发一收）：`{ local: 0, storage: 1, bc: 1 }` —— 收到 2 次。
 * 由于 Layout 的订阅回调每次都会重新拉 `/api/public` 与主题样式表，一次管理员写操作
 * 会让每个在线观众发出 8 个请求（两个端点 × 4 次回调），且随在线人数线性放大。
 *
 * 这里统一为：**发送只走一条跨标签页通道**（优先 BroadcastChannel），
 * 接收仍监听两条以防某条被浏览器扩展拦截，并按消息 id 去重兜底。
 */

type CrossTabEnvelope = { type: string; id: string; at: number; source?: string; detail?: unknown };

const SEEN_TTL_MS = 15_000;
const sourceId = newId();
type EventSubscription = {
  callbacks: Set<(detail?: unknown) => void>;
  channel: BroadcastChannel | null;
  close: () => void;
};
const subscriptions = new Map<string, EventSubscription>();

function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* 某些环境下 randomUUID 不可用 */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function alreadyHandled(id: unknown, seenIds: Map<string, number>): boolean {
  if (typeof id !== 'string' || !id) return false;
  const now = Date.now();
  for (const [key, at] of seenIds) {
    if (now - at > SEEN_TTL_MS) seenIds.delete(key);
  }
  if (seenIds.has(id)) return true;
  seenIds.set(id, now);
  return false;
}

/** 同标签页派发 CustomEvent，并向其他标签页广播一次（且仅一次）。 */
export function broadcastCrossTab(eventName: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  const envelope: CrossTabEnvelope = { type: eventName, id: newId(), at: Date.now(), source: sourceId, detail };

  window.dispatchEvent(new CustomEvent(eventName, { detail }));

  if (hasBroadcastChannel()) {
    try {
      const sharedChannel = subscriptions.get(eventName)?.channel;
      const channel = sharedChannel || new BroadcastChannel(eventName);
      channel.postMessage(envelope);
      if (!sharedChannel) channel.close();
      return;
    } catch { /* 落到 localStorage 兜底 */ }
  }
  try {
    localStorage.setItem(eventName, JSON.stringify(envelope));
    localStorage.removeItem(eventName);
  } catch { /* 隐私模式下可能不可写；此时仅同标签页生效 */ }
}

/**
 * 订阅事件。回调在以下三种来源上触发，跨标签页来源按 id 去重：
 * 同标签页 CustomEvent、BroadcastChannel、localStorage storage 事件。
 */
export function subscribeCrossTab(
  eventName: string,
  callback: (detail?: unknown) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  let subscription = subscriptions.get(eventName);
  if (!subscription) {
    const callbacks = new Set<(detail?: unknown) => void>();
    const seenIds = new Map<string, number>();
    const deliver = (detail?: unknown) => {
      for (const listener of [...callbacks]) listener(detail);
    };
    const receive = (data: Partial<CrossTabEnvelope> | undefined) => {
      if (data?.type !== eventName || data.source === sourceId) return;
      if (alreadyHandled(data.id, seenIds)) return;
      deliver(data.detail);
    };
    const onLocalEvent = (event: Event) => deliver(event instanceof CustomEvent ? event.detail : undefined);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== eventName) return;
      if (!event.newValue) return;
      try { receive(JSON.parse(event.newValue) as Partial<CrossTabEnvelope>); }
      catch { deliver(undefined); }
    };
    let channel: BroadcastChannel | null = null;
    if (hasBroadcastChannel()) {
      try {
        channel = new BroadcastChannel(eventName);
        channel.onmessage = (event: MessageEvent) => receive(event.data as Partial<CrossTabEnvelope> | undefined);
      } catch { /* 不可用时仅靠 storage 事件 */ }
    }
    window.addEventListener(eventName, onLocalEvent);
    window.addEventListener('storage', onStorage);
    subscription = {
      callbacks,
      channel,
      close: () => {
        window.removeEventListener(eventName, onLocalEvent);
        window.removeEventListener('storage', onStorage);
        channel?.close();
      },
    };
    subscriptions.set(eventName, subscription);
  }
  subscription.callbacks.add(callback);
  const activeSubscription = subscription;
  return () => {
    activeSubscription.callbacks.delete(callback);
    if (activeSubscription.callbacks.size === 0 && subscriptions.get(eventName) === activeSubscription) {
      activeSubscription.close();
      subscriptions.delete(eventName);
    }
  };
}
