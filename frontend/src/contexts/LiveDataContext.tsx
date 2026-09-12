/**
 * LiveDataContext - 实时数据上下文
 * 优先通过 WebSocket 接收实时数据，HTTP 轮询作为断线兜底
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  DEFAULT_LIVE_POLL_CONFIG,
  getLivePollDelay,
  getLiveWsReconnectDelay,
  isLiveWsCircuitOpen,
  LIVE_POLL_SETTINGS_UPDATED_EVENT,
  normalizeLivePollConfig,
  shouldPollLiveData,
  shouldReconnectLiveWebSocket,
  type LivePollConfig,
} from './livePolling';
import { fetchPublicSettings, normalizePublicSettings, setCachedPublicSettings } from '../utils/publicSettings';
import { fetchPublicBootstrap, getCachedPublicBootstrap } from '../utils/publicBootstrap';
import { normalizeLastKnownRecord, normalizeLiveDataResponse, normalizeViewerTokenResponse } from '../utils/liveDataResponse';
import { notifyPublicDataUpdated, subscribePublicDataUpdated } from '../utils/publicDataEvents';
import type { PublicDataUpdateDetail } from '../utils/publicDataEvents';
import { mergePublicClientPatch } from '../utils/publicClients';
import type { ClientInfo } from '../types';
import { notifyWebsiteMonitorsUpdated, type WebsiteMonitorsUpdateDetail } from '../utils/websiteMonitorEvents';
import { useAuth } from './AuthContext';

export interface LiveRecord {
  cpu: number;
  gpu?: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number | null;
  disk_total: number | null;
  disk_source?: 'directory';
  disk_sampled_at?: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  // null = 本机负载不可取信（容器内 /proc/loadavg 透传宿主机），不是 0。
  load: number | null;
  // null = 主机温度未采集或不可用；0 和负值仍是有效摄氏温度。
  temp: number | null;
  uptime: number | null;
  process_count: number;
  connections: number;
  connections_udp: number;
  message?: string;
  lastReportTime?: number;
}

export type LastKnownRecord = Partial<LiveRecord> & {
  uuid: string;
  name: string;
  lastReportTime: number;
  sort_order?: number;
};

export interface LiveDataResponse {
  online: string[];
  clients: Array<{ uuid: string; name: string; lastReportTime: number; region?: string; sort_order?: number } & Partial<LiveRecord>>;
  data: Record<string, LiveRecord>;
  last_known?: Record<string, LastKnownRecord>;
  count: number;
  timestamp: number;
  metadata_version?: string;
}

type LiveDataSnapshotMessage = LiveDataResponse & { type: 'snapshot' };

interface LiveDataUpdateMessage {
  type: 'update';
  client: string;
  name?: string;
  data?: Partial<LiveRecord>;
  timestamp: number;
}

interface LiveDataRemoveMessage {
  type: 'remove';
  client: string;
  timestamp: number;
  reason?: 'offline';
  last_known?: LastKnownRecord;
}

interface LiveDataViewerExpiredMessage {
  type: 'viewer_expired';
  timestamp: number;
}

interface LiveDataMetadataChangedMessage {
  type: 'metadata_changed';
  timestamp: number;
  websites?: true | WebsiteMonitorsUpdateDetail;
  clients?: {
    upsert?: unknown[];
    remove?: string[];
  };
}

const LIVE_WS_INITIAL_SNAPSHOT_TIMEOUT_MS = 4_000;
const LIVE_VIEWER_WS_PROTOCOL = 'cf-monitor-viewer';

export function buildLiveWebSocketUrl(origin: string, pathname = '/api/ws/live'): string {
  const url = new URL(pathname, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function buildLiveWebSocketProtocols(viewerToken: string): string[] {
  return [LIVE_VIEWER_WS_PROTOCOL, viewerToken];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load live data';
}

function isSnapshotMessage(value: unknown): value is LiveDataSnapshotMessage {
  return isRecord(value) && value.type === 'snapshot' && normalizeLiveDataResponse(value) !== null;
}

function isUpdateMessage(value: unknown): value is LiveDataUpdateMessage {
  return isRecord(value) && value.type === 'update' && typeof value.client === 'string' && typeof value.timestamp === 'number';
}

function isRemoveMessage(value: unknown): value is LiveDataRemoveMessage {
  return isRecord(value) && value.type === 'remove' && typeof value.client === 'string';
}

function isViewerExpiredMessage(value: unknown): value is LiveDataViewerExpiredMessage {
  return isRecord(value) && value.type === 'viewer_expired' && typeof value.timestamp === 'number';
}

function isMetadataChangedMessage(value: unknown): value is LiveDataMetadataChangedMessage {
  return isRecord(value) && value.type === 'metadata_changed';
}

function isEmptyLiveSnapshot(snapshot: LiveDataResponse) {
  return snapshot.count === 0 && snapshot.online.length === 0 && snapshot.clients.length === 0;
}

export function applyLiveUpdate(
  current: LiveDataResponse | null,
  message: LiveDataUpdateMessage,
): LiveDataResponse {
  const base: LiveDataResponse = current || {
    online: [],
    clients: [],
    data: {},
    count: 0,
    timestamp: 0,
  };
  const uuid = message.client;
  const previousClient = base.clients.find(client => client.uuid === uuid);
  const nextRecord = {
    ...(base.data[uuid] || {}),
    ...(message.data || {}),
    lastReportTime: message.timestamp,
  } as LiveRecord;
  const nextOnline = base.online.includes(uuid) ? base.online : [...base.online, uuid];
  const nextClient = {
    ...previousClient,
    ...nextRecord,
    uuid,
    name: message.name || previousClient?.name || uuid,
    lastReportTime: message.timestamp,
  };
  const { [uuid]: _lastKnown, ...lastKnown } = base.last_known || {};

  return {
    ...base,
    online: nextOnline,
    clients: [
      ...base.clients.filter(client => client.uuid !== uuid),
      nextClient,
    ],
    data: {
      ...base.data,
      [uuid]: nextRecord,
    },
    last_known: lastKnown,
    count: nextOnline.length,
    timestamp: message.timestamp,
  };
}

export function applyLiveRemove(
  current: LiveDataResponse | null,
  message: LiveDataRemoveMessage,
): LiveDataResponse | null {
  const explicitLast = message.reason === 'offline' ? normalizeLastKnownRecord(message.last_known, message.client) : null;
  if (!current && !explicitLast) return current;
  const base: LiveDataResponse = current || { online: [], clients: [], data: {}, count: 0, timestamp: 0 };
  const { [message.client]: removed, ...data } = base.data;
  const online = base.online.filter(uuid => uuid !== message.client);
  const { [message.client]: previousLast, ...lastKnown } = base.last_known || {};
  if (message.reason === 'offline') {
    const client = base.clients.find(client => client.uuid === message.client);
    const previous = normalizeLastKnownRecord({ ...client, ...removed, uuid: message.client,
      name: client?.name, lastReportTime: client?.lastReportTime ?? removed?.lastReportTime }, message.client) || previousLast;
    const last = explicitLast && (!previous || explicitLast.lastReportTime >= previous.lastReportTime) ? explicitLast : previous;
    if (last) lastKnown[message.client] = last;
  }

  return {
    ...base,
    online,
    clients: base.clients.filter(client => client.uuid !== message.client),
    data,
    last_known: lastKnown,
    count: online.length,
    timestamp: message.timestamp,
  };
}

type LivePatch = LiveDataUpdateMessage | LiveDataRemoveMessage;
type LiveSnapshotRead = { priorUpdates: LivePatch[]; updates: LivePatch[] };

/** One mounted authorization scope owns all full snapshots and intervening socket patches. */
export function createLiveSnapshotScope(owner: object = {}) {
  let active = true;
  let hasSnapshot = false;
  let current: LiveDataResponse | null = null;
  let pending: LiveSnapshotRead | null = null;
  let initialUpdates: LivePatch[] = [];
  const apply = (value: LiveDataResponse | null, patch: LivePatch) => patch.type === 'update'
    ? applyLiveUpdate(value, patch) : applyLiveRemove(value, patch);
  const merge = (snapshot: LiveDataResponse, updates: LivePatch[]) => updates.reduce<LiveDataResponse>(
    (value, update) => apply(value, update) ?? value, snapshot,
  );
  // A retry may return a baseline newer than patches left by its failed predecessor.
  // Patches arriving during this read still replay by request ownership.
  const mergePrior = (snapshot: LiveDataResponse, updates: LivePatch[]) => merge(
    snapshot, updates.filter(update => update.timestamp > snapshot.timestamp),
  );

  return {
    owner,
    get active() { return active; },
    get hasSnapshot() { return hasSnapshot; },
    beginRead(): LiveSnapshotRead {
      pending = { priorUpdates: [...initialUpdates], updates: [] };
      return pending;
    },
    isCurrent(request: LiveSnapshotRead) { return active && pending === request; },
    canReportError(request: LiveSnapshotRead) {
      return active && pending === request && (!hasSnapshot || request.updates.length === 0);
    },
    finishRead(request: LiveSnapshotRead) { if (pending === request) pending = null; },
    complete(request: LiveSnapshotRead, snapshot: LiveDataResponse) {
      if (!active || pending !== request) return undefined;
      current = merge(mergePrior({ ...snapshot, last_known: snapshot.last_known || {} }, request.priorUpdates), request.updates);
      hasSnapshot = true;
      initialUpdates = [];
      pending = null;
      return current;
    },
    snapshot(snapshot: LiveDataResponse) {
      if (!active) return undefined;
      pending = null;
      initialUpdates = [];
      hasSnapshot = true;
      current = { ...snapshot, last_known: snapshot.last_known || {} };
      return current;
    },
    seed(snapshot: LiveDataResponse) {
      if (!active || hasSnapshot) return undefined;
      current = mergePrior({ ...snapshot, last_known: snapshot.last_known || {} }, initialUpdates);
      initialUpdates = [];
      hasSnapshot = true;
      return current;
    },
    patch(message: LivePatch) {
      if (!active) return undefined;
      if (!hasSnapshot) initialUpdates.push(message);
      pending?.updates.push(message);
      current = apply(current, message);
      return current;
    },
    dispose() {
      active = false;
      pending = null;
      initialUpdates = [];
      current = null;
    },
  };
}

interface LiveDataContextType {
  liveData: LiveDataResponse | null;
  snapshotReady: boolean;
  clientMetadata: ClientInfo[] | undefined;
  setClientMetadata: React.Dispatch<React.SetStateAction<ClientInfo[] | undefined>>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const LiveDataContext = createContext<LiveDataContextType>({
  liveData: null,
  snapshotReady: false,
  clientMetadata: undefined,
  setClientMetadata: () => {},
  loading: true,
  error: null,
  refresh: () => {},
});

export function useLiveData() {
  return useContext(LiveDataContext);
}

interface LiveDataProviderProps {
  children: React.ReactNode;
  enabled?: boolean;
  viewer?: boolean;
}

export function LiveDataProvider({ children, enabled = true, viewer = true }: LiveDataProviderProps) {
  const { authLoading, isAuthenticated, user } = useAuth();
  const includeHidden = !authLoading && isAuthenticated;
  const scopeOwner = useMemo(() => ({}), [authLoading, enabled, includeHidden, viewer, user?.uuid]);
  const liveScopeRef = useRef<ReturnType<typeof createLiveSnapshotScope> | null>(null);
  const [liveData, setLiveData] = useState<LiveDataResponse | null>(null);
  const [clientMetadataState, setClientMetadataState] = useState<{ owner: object; clients: ClientInfo[] | undefined }>({ owner: scopeOwner, clients: undefined });
  const setClientMetadata = useCallback<LiveDataContextType['setClientMetadata']>((update) => {
    if (!liveScopeRef.current?.active || liveScopeRef.current.owner !== scopeOwner) return;
    setClientMetadataState(current => {
      if (!liveScopeRef.current?.active || liveScopeRef.current.owner !== scopeOwner) return current;
      const previous = current.owner === scopeOwner ? current.clients : undefined;
      return { owner: scopeOwner, clients: typeof update === 'function' ? update(previous) : update };
    });
  }, [scopeOwner]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialSnapshotTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsOpenRef = useRef(false);
  /** 连续重连失败次数；`open` 成功归零，达到阈值即熔断（见 livePolling.ts）。 */
  const wsFailStreakRef = useRef(0);
  const metadataVersionRef = useRef<string | null>(null);
  const pollConfigRef = useRef<LivePollConfig>(DEFAULT_LIVE_POLL_CONFIG);
  const activeSinceRef = useRef<number | null>(
    enabled && viewer ? Date.now() : null,
  );

  useEffect(() => {
    const scope = createLiveSnapshotScope(scopeOwner);
    liveScopeRef.current = scope;
    metadataVersionRef.current = null;
    setLiveData(null);
    setClientMetadataState({ owner: scopeOwner,
      clients: !authLoading && !includeHidden && enabled && viewer ? getCachedPublicBootstrap()?.clients : undefined });
    setError(null);
    return () => {
      scope.dispose();
      if (liveScopeRef.current === scope) liveScopeRef.current = null;
    };
  }, [scopeOwner]);

  function applyLiveMetadataVersion(version: string | undefined) {
    if (!version) return;
    if (metadataVersionRef.current === null) {
      metadataVersionRef.current = version;
      return;
    }
    if (metadataVersionRef.current !== version) {
      metadataVersionRef.current = version;
      notifyPublicDataUpdated({ force: true });
    }
  }

  function rememberInitialLiveMetadataVersion(version: string | undefined) {
    if (version && metadataVersionRef.current === null) {
      metadataVersionRef.current = version;
    }
  }

  const fetchLiveData = useCallback(async () => {
    if (authLoading) {
      setLoading(true);
      return;
    }
    const scope = liveScopeRef.current;
    if (!enabled || !scope?.active || scope.owner !== scopeOwner) return;
    const request = scope.beginRead();
    try {
      const res = await fetch(`/api/live/clients${includeHidden ? '?include_hidden=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = normalizeLiveDataResponse(await res.json());
      if (!data) throw new Error('Invalid live data response');
      const committed = scope.complete(request, data);
      if (!committed) return;
      applyLiveMetadataVersion(data.metadata_version);
      setLiveData(committed);
      setError(null);
      setLoading(false);
    } catch (error: unknown) {
      if (scope.canReportError(request)) setError(getErrorMessage(error));
    } finally {
      if (scope.isCurrent(request)) {
        scope.finishRead(request);
        setLoading(false);
      }
    }
  }, [authLoading, enabled, includeHidden, scopeOwner]);

  const refresh = useCallback(() => {
    fetchLiveData();
  }, [fetchLiveData]);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!enabled || !viewer) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let settingsRequest = 0;
    let pendingMetadataUpdates: PublicDataUpdateDetail[] | null = null;
    const scope = liveScopeRef.current;
    if (!scope) return;

    const applySettings = (settings: unknown) => {
      const normalized = normalizePublicSettings(settings);
      if (normalized) {
        setCachedPublicSettings(normalized);
      }
      pollConfigRef.current = normalizeLivePollConfig(normalized);
    };

    const applyBootstrap = (payload: Awaited<ReturnType<typeof fetchPublicBootstrap>> | null | undefined, request: LiveSnapshotRead) => {
      if (payload?.settings) {
        applySettings(payload.settings);
      }
      const live = normalizeLiveDataResponse(payload?.live);
      if (live) {
        const committed = scope.complete(request, live);
        if (!committed) return;
        rememberInitialLiveMetadataVersion(payload?.metadata_version || live.metadata_version);
        setLiveData(committed);
        setLoading(false);
        setError(null);
      }
    };

    const loadSettings = (fresh = false) => {
      const request = ++settingsRequest;
      const updates: PublicDataUpdateDetail[] = [];
      pendingMetadataUpdates = updates;
      const liveRequest = scope.beginRead();
      const isCurrent = () => !cancelled && request === settingsRequest;
      fetchPublicBootstrap({ ...(fresh ? { cache: 'reload' as const, cacheBust: true } : {}), includeHidden })
        .then((payload) => {
          if (isCurrent()) {
            if (payload.clients !== undefined) {
              setClientMetadata(updates.reduce((clients, update) => mergePublicClientPatch(clients, update, { includeHidden }), payload.clients));
            }
            applyBootstrap(payload, liveRequest);
          }
        })
        .catch(() => {
          if (!isCurrent()) return;
          return fetchPublicSettings()
            .then((settings) => {
              if (isCurrent()) {
                applySettings(settings);
              }
            })
            .catch(() => {
              if (isCurrent()) {
                pollConfigRef.current = DEFAULT_LIVE_POLL_CONFIG;
              }
            });
        })
        .finally(() => { if (isCurrent()) pendingMetadataUpdates = null; });
    };

    const handleSettingsUpdated = (event: Event) => {
      if (cancelled) return;
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail && typeof detail === 'object') {
        settingsRequest += 1;
        pendingMetadataUpdates = null;
        applySettings(detail);
      } else {
        loadSettings();
      }
    };

    loadSettings();
    window.addEventListener(LIVE_POLL_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    const unsubscribePublicData = subscribePublicDataUpdated((detail) => {
      if (detail?.clients) {
        pendingMetadataUpdates?.push(detail);
        setClientMetadata(current => current === undefined ? undefined : mergePublicClientPatch(current, detail, { includeHidden }));
        for (const client of detail.clients.remove || []) {
          const patched = scope.patch({ type: 'remove', client, timestamp: Date.now() });
          if (patched !== undefined) setLiveData(patched);
        }
        return;
      }
      // Revalidation is not an empty list. Keep this authorization scope's
      // confirmed cards until the fresh list arrives; auth changes and explicit
      // removals still clear their data through the existing scope/delta paths.
      loadSettings(true);
    });

    return () => {
      cancelled = true;
      window.removeEventListener(LIVE_POLL_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      unsubscribePublicData();
    };
  }, [authLoading, enabled, includeHidden, viewer, setClientMetadata]);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!enabled || !viewer) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let connectionRequest = 0;
    const scope = liveScopeRef.current;
    if (!scope) return;

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const clearInitialSnapshotTimeout = () => {
      if (initialSnapshotTimeoutRef.current) {
        clearTimeout(initialSnapshotTimeoutRef.current);
        initialSnapshotTimeoutRef.current = null;
      }
    };

    /**
     * 排期一次重连。
     * - 隐藏时不重连：没人在看，切回可见时由 visibilitychange 立刻补连。
     * - 连续失败达阈值即熔断：多为代理/防火墙硬阻断 WebSocket，重试无意义。
     * - 退避封顶 60 秒：可见状态下滞留在 HTTP 轮询比重连本身更贵。
     */
    const scheduleReconnect = () => {
      clearReconnectTimeout();
      if (cancelled) return;
      if (!shouldReconnectLiveWebSocket({
        expired: isLiveWsCircuitOpen(wsFailStreakRef.current),
        hidden: document.hidden,
      })) return;
      reconnectTimeoutRef.current = setTimeout(
        () => {
          // 排期时可见、触发时可能已切到后台。必须在触发点再判一次，
          // 否则一个已排期的重连会漏过 hidden 守卫（实测确有 1 次漏网）。
          if (cancelled || document.hidden) return;
          void connect();
        },
        getLiveWsReconnectDelay(wsFailStreakRef.current - 1),
      );
    };

    const connect = async () => {
      if (cancelled || typeof WebSocket === 'undefined') return;
      const connection = ++connectionRequest;

      let viewerToken = '';
      try {
        const bootstrap = includeHidden ? null : getCachedPublicBootstrap();
        const live = normalizeLiveDataResponse(bootstrap?.live);
        if (live) {
          const seeded = scope.seed(live);
          if (seeded) {
            rememberInitialLiveMetadataVersion(bootstrap?.metadata_version || live.metadata_version);
            setLiveData(seeded);
            setLoading(false);
          }
        }
        const tokenResponse = await fetch('/api/ws/live-token');
        if (!tokenResponse.ok) throw new Error(`HTTP ${tokenResponse.status}`);
        const tokenData = normalizeViewerTokenResponse(await tokenResponse.json());
        if (!tokenData) throw new Error('Invalid live token response');
        viewerToken = tokenData.token;
      } catch {
        if (cancelled || !scope.active || connectionRequest !== connection) return;
        // 取证失败也算一次重连失败，否则连接将永远无法自愈。
        wsFailStreakRef.current += 1;
        if (!document.hidden) void fetchLiveData();
        scheduleReconnect();
        return;
      }
      if (cancelled || !scope.active || connectionRequest !== connection || !viewerToken) return;

      const ws = new WebSocket(
        buildLiveWebSocketUrl(window.location.origin, `/api/ws/live${includeHidden ? '?include_hidden=1' : ''}`),
        buildLiveWebSocketProtocols(viewerToken),
      );
      wsRef.current = ws;
      const isCurrentSocket = () => !cancelled && scope.active && wsRef.current === ws;

      ws.addEventListener('open', () => {
        if (!isCurrentSocket()) return;
        wsOpenRef.current = true;
        wsFailStreakRef.current = 0;
        if (scope.hasSnapshot) setError(null);
        clearInitialSnapshotTimeout();
        initialSnapshotTimeoutRef.current = setTimeout(() => {
          if (!cancelled && wsRef.current === ws) {
            void fetchLiveData();
          }
        }, LIVE_WS_INITIAL_SNAPSHOT_TIMEOUT_MS);
      });

      ws.addEventListener('message', (event) => {
        if (!isCurrentSocket()) return;
        try {
          const message = JSON.parse(event.data);
          if (isSnapshotMessage(message)) {
            clearInitialSnapshotTimeout();
            const { type: _type, ...snapshot } = message;
            const normalized = normalizeLiveDataResponse(snapshot);
            if (!normalized) return;
            scope.snapshot(normalized);
            applyLiveMetadataVersion(normalized.metadata_version);
            if (isEmptyLiveSnapshot(normalized)) {
              setLiveData(normalized);
              setLoading(false);
              setError(null);
              return;
            }
            setLiveData(normalized);
            setLoading(false);
            setError(null);
            if ((snapshot.count || 0) === 0 && snapshot.online.length === 0) {
              void fetchLiveData();
            }
            return;
          }
          if (isUpdateMessage(message)) {
            clearInitialSnapshotTimeout();
            const patched = scope.patch(message);
            if (patched !== undefined) setLiveData(patched);
            if (scope.hasSnapshot) {
              setLoading(false);
              setError(null);
            }
            return;
          }
          if (isRemoveMessage(message)) {
            clearInitialSnapshotTimeout();
            const patched = scope.patch(message);
            if (patched !== undefined) setLiveData(patched);
            if (scope.hasSnapshot) setLoading(false);
            return;
          }
          if (isViewerExpiredMessage(message)) {
            clearInitialSnapshotTimeout();
            // 决策 5：隐藏时不续期，让 viewer 身份自然失效，探针回落到 idle 上报。
            // 先摘掉 wsRef 再 close，使 close 处理器走"非意外关闭"分支、不累计失败。
            if (document.hidden) {
              wsRef.current = null;
              wsOpenRef.current = false;
              try { ws.close(); } catch { /* 已关闭时忽略 */ }
              return;
            }
            reconnectLiveWebSocket();
            return;
          }
          if (isMetadataChangedMessage(message)) {
            if (message.websites) notifyWebsiteMonitorsUpdated(message.websites);
            if (message.clients) {
              notifyPublicDataUpdated({ clients: message.clients });
            } else if (!message.websites) {
              notifyPublicDataUpdated();
            }
            // 纯网站监控变更（live-data.ts:1610 的 `{ websites: true }`）不再走
            // notifyPublicDataUpdated：/api/public/bootstrap 的内容是"设置 + 客户端快照
            // + 实时快照"，不含网站数据，网站本身已由上面的 notifyWebsiteMonitorsUpdated
            // 经 /api/websites 单独刷新。此前无条件调用会扇出到 4 个订阅者
            // （Layout 主题+站点设置、LiveDataContext bootstrap、Index 客户端列表、
            // Dashboard 管理端列表），实测 2 次/分 × 3 请求 = 360 请求/小时/标签页，
            // 且与标签页是否可见无关。
            return;
          }
        } catch {
          // Ignore malformed live messages and let the HTTP fallback repair state.
        }
      });

      ws.addEventListener('error', () => {
        if (isCurrentSocket()) {
          clearInitialSnapshotTimeout();
          setError('Live WebSocket unavailable');
          void fetchLiveData();
        }
      });

      ws.addEventListener('close', () => {
        if (!isCurrentSocket()) return;
        wsRef.current = null;
        wsOpenRef.current = false;
        if (cancelled) return;
        clearInitialSnapshotTimeout();
        wsFailStreakRef.current += 1;
        // 补上轮询排期的空档：WS 开着时轮询按 idleIntervalMs 排期，
        // 断开后下一次轮询可能还有两分钟才到。隐藏时没有轮询要补，也没人在看。
        if (!document.hidden) void fetchLiveData();
        scheduleReconnect();
      });
    };

    const reconnectLiveWebSocket = () => {
      wsOpenRef.current = false;
      setLoading(false);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {}
      }
      clearReconnectTimeout();
      reconnectTimeoutRef.current = setTimeout(() => { void connect(); }, 0);
    };

    /**
     * 切回前台时：熔断计数归零并立刻重连一次。
     * 网络环境可能已经变了（换 WiFi、离开公司代理），值得免费再试一次。
     */
    const handleWsVisibility = () => {
      if (cancelled || document.hidden) return;
      wsFailStreakRef.current = 0;
      if (!wsRef.current) {
        clearReconnectTimeout();
        void connect();
      }
    };

    document.addEventListener('visibilitychange', handleWsVisibility);
    // focus 在双屏/多窗口切换时会触发而 visibilitychange 不会，
    // 多挂一个入口让熔断后的恢复更及时（有 wsRef 判空兜底，不会重复建连）。
    window.addEventListener('focus', handleWsVisibility);
    void connect();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleWsVisibility);
      window.removeEventListener('focus', handleWsVisibility);
      clearReconnectTimeout();
      clearInitialSnapshotTimeout();
      wsOpenRef.current = false;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [authLoading, enabled, fetchLiveData, includeHidden, viewer]);

  // 轮询
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let lastScheduledDelay = 0;
    let lastScheduleWasIdle = false;

    const clearPollTimeout = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    if (authLoading) {
      setLoading(true);
      return () => {
        cancelled = true;
        clearPollTimeout();
      };
    }

    if (!enabled) {
      setLoading(false);
      return () => {
        cancelled = true;
        clearPollTimeout();
      };
    }

    if (!viewer) {
      const scheduleSnapshotPoll = () => {
        clearPollTimeout();
        if (cancelled) return;
        timeoutRef.current = setTimeout(
          pollSnapshot,
          DEFAULT_LIVE_POLL_CONFIG.idleIntervalMs,
        );
      };

      const pollSnapshot = async () => {
        if (polling || cancelled) return;
        polling = true;
        try {
          await fetchLiveData();
        } finally {
          polling = false;
          scheduleSnapshotPoll();
        }
      };

      const handleVisibility = () => {
        clearPollTimeout();
        void pollSnapshot();
      };

      document.addEventListener('visibilitychange', handleVisibility);
      void pollSnapshot();

      return () => {
        cancelled = true;
        clearPollTimeout();
        document.removeEventListener('visibilitychange', handleVisibility);
      };
    }

    const scheduleNextPoll = () => {
      clearPollTimeout();
      if (cancelled) return;
      // 决策 4：隐藏且 WS 未连通时完全不轮询——拉回来的数据没有任何人会看到，
      // 切回可见时 handleVisibility 会立刻补拉一次。
      if (!shouldPollLiveData({ hidden: document.hidden, wsOpen: wsOpenRef.current })) {
        lastScheduledDelay = 0;
        lastScheduleWasIdle = true;
        return;
      }
      const now = Date.now();
      if (activeSinceRef.current === null) {
        activeSinceRef.current = now;
      }
      const config = pollConfigRef.current;
      if (wsOpenRef.current) {
        lastScheduledDelay = config.idleIntervalMs;
        lastScheduleWasIdle = true;
        timeoutRef.current = setTimeout(poll, lastScheduledDelay);
        return;
      }
      lastScheduledDelay = getLivePollDelay({
        hidden: document.hidden,
        activeSince: activeSinceRef.current,
        now,
        config,
      });
      lastScheduleWasIdle = wsOpenRef.current ||
        (activeSinceRef.current !== null && now - activeSinceRef.current >= config.activeMaxDurationMs);
      timeoutRef.current = setTimeout(poll, lastScheduledDelay);
    };

    const poll = async () => {
      if (polling || cancelled) return;
      if (wsOpenRef.current) {
        scheduleNextPoll();
        return;
      }
      if (!shouldPollLiveData({ hidden: document.hidden, wsOpen: wsOpenRef.current })) return;
      polling = true;
      try {
        await fetchLiveData();
      } finally {
        polling = false;
        scheduleNextPoll();
      }
    };

    const handleVisibility = () => {
      refreshVisibleData();
      clearPollTimeout();
      scheduleNextPoll();
    };

    const refreshVisibleData = () => {
      // visibilitychange 在"切走"时也会触发，那一次拉取没有任何人会看到。
      if (cancelled || document.hidden || wsOpenRef.current) return;
      activeSinceRef.current = Date.now();
      void fetchLiveData();
    };

    const handleUserActivity = () => {
      if (cancelled) return;
      activeSinceRef.current = Date.now();
      if (lastScheduleWasIdle) {
        clearPollTimeout();
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', refreshVisibleData);
    window.addEventListener('pointerdown', handleUserActivity);
    window.addEventListener('keydown', handleUserActivity);
    window.addEventListener('scroll', handleUserActivity, { passive: true });
    poll();

    return () => {
      cancelled = true;
      clearPollTimeout();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', refreshVisibleData);
      window.removeEventListener('pointerdown', handleUserActivity);
      window.removeEventListener('keydown', handleUserActivity);
      window.removeEventListener('scroll', handleUserActivity);
    };
  }, [authLoading, enabled, fetchLiveData, viewer]);

  const ownsScope = !authLoading && liveScopeRef.current?.owner === scopeOwner;
  return (
    <LiveDataContext.Provider value={{ liveData: ownsScope ? liveData : null, snapshotReady: Boolean(ownsScope && liveScopeRef.current?.hasSnapshot),
      clientMetadata: ownsScope && clientMetadataState.owner === scopeOwner ? clientMetadataState.clients : undefined,
      setClientMetadata, loading, error, refresh }}>
      {children}
    </LiveDataContext.Provider>
  );
}
