/**
 * LiveDataContext - 实时数据上下文
 * 优先通过 WebSocket 接收实时数据，HTTP 轮询作为断线兜底
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  DEFAULT_LIVE_POLL_CONFIG,
  getLivePollDelay,
  getFallbackViewerExpiry,
  isViewerWindowExpired,
  LIVE_POLL_SETTINGS_UPDATED_EVENT,
  normalizeLivePollConfig,
  shouldReconnectLiveWebSocket,
  type LivePollConfig,
} from './livePolling';
import { clearCachedPublicSettings, fetchPublicSettings, normalizePublicSettings, setCachedPublicSettings } from '../utils/publicSettings';
import { clearCachedPublicBootstrap, fetchPublicBootstrap, getCachedPublicBootstrap } from '../utils/publicBootstrap';
import { normalizeLiveDataResponse, normalizeViewerTokenResponse } from '../utils/liveDataResponse';
import { notifyPublicDataUpdated, subscribePublicDataUpdated } from '../utils/publicDataEvents';
import { notifyWebsiteMonitorsUpdated, type WebsiteMonitorsUpdateDetail } from '../utils/websiteMonitorEvents';
import { useAuth } from './AuthContext';

export interface LiveRecord {
  cpu: number;
  gpu?: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number;
  disk_total: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  load: number;
  temp: number;
  uptime: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  message?: string;
}

export interface LiveDataResponse {
  online: string[];
  clients: Array<{ uuid: string; name: string; lastReportTime: number; region?: string } & Partial<LiveRecord>>;
  data: Record<string, LiveRecord>;
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
    ...nextRecord,
    uuid,
    name: message.name || previousClient?.name || uuid,
    lastReportTime: message.timestamp,
  };

  return {
    online: nextOnline,
    clients: [
      ...base.clients.filter(client => client.uuid !== uuid),
      nextClient,
    ],
    data: {
      ...base.data,
      [uuid]: nextRecord,
    },
    count: nextOnline.length,
    timestamp: message.timestamp,
  };
}

export function applyLiveRemove(
  current: LiveDataResponse | null,
  message: LiveDataRemoveMessage,
): LiveDataResponse | null {
  if (!current) return current;
  const { [message.client]: _removed, ...data } = current.data;
  const online = current.online.filter(uuid => uuid !== message.client);

  return {
    ...current,
    online,
    clients: current.clients.filter(client => client.uuid !== message.client),
    data,
    count: online.length,
    timestamp: message.timestamp,
  };
}

interface LiveDataContextType {
  liveData: LiveDataResponse | null;
  loading: boolean;
  error: string | null;
  viewerExpired: boolean;
  viewerExpiresAt: number | null;
  refresh: () => void;
}

const LiveDataContext = createContext<LiveDataContextType>({
  liveData: null,
  loading: true,
  error: null,
  viewerExpired: false,
  viewerExpiresAt: null,
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
  const { authLoading, isAuthenticated } = useAuth();
  const includeHidden = !authLoading && isAuthenticated;
  const [liveData, setLiveData] = useState<LiveDataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerExpired, setViewerExpired] = useState(false);
  const [viewerExpiresAt, setViewerExpiresAt] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialSnapshotTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsOpenRef = useRef(false);
  const wsExpiredRef = useRef(false);
  const metadataVersionRef = useRef<string | null>(null);
  const pollConfigRef = useRef<LivePollConfig>(DEFAULT_LIVE_POLL_CONFIG);
  const fallbackExpiresAtRef = useRef<number | null>(null);
  const activeSinceRef = useRef<number | null>(
    enabled && viewer ? Date.now() : null,
  );

  const expireViewerSession = useCallback(() => {
    wsExpiredRef.current = true;
    wsOpenRef.current = false;
    fallbackExpiresAtRef.current = null;
    setViewerExpired(true);
    setViewerExpiresAt(null);
    setError(null);
    setLoading(false);
  }, []);

  const ensureFallbackViewerWindow = useCallback((now = Date.now()) => {
    if (fallbackExpiresAtRef.current === null) {
      fallbackExpiresAtRef.current = getFallbackViewerExpiry({
        currentExpiresAt: fallbackExpiresAtRef.current,
        now,
        config: pollConfigRef.current,
      });
      setViewerExpiresAt(fallbackExpiresAtRef.current);
      setViewerExpired(false);
    }
    return fallbackExpiresAtRef.current;
  }, []);

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
    if (wsExpiredRef.current) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/live/clients${includeHidden ? '?include_hidden=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = normalizeLiveDataResponse(await res.json());
      if (!data) throw new Error('Invalid live data response');
      applyLiveMetadataVersion(data.metadata_version);
      setLiveData(current => current && !isEmptyLiveSnapshot(current) && isEmptyLiveSnapshot(data) ? current : data);
      setError(null);
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [authLoading, includeHidden]);

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

    const applySettings = (settings: unknown) => {
      const normalized = normalizePublicSettings(settings);
      if (normalized) {
        setCachedPublicSettings(normalized);
      }
      pollConfigRef.current = normalizeLivePollConfig(normalized);
      fallbackExpiresAtRef.current = null;
    };

    const applyBootstrap = (payload: Awaited<ReturnType<typeof fetchPublicBootstrap>> | null | undefined) => {
      if (payload?.settings) {
        applySettings(payload.settings);
      }
      const live = normalizeLiveDataResponse(payload?.live);
      rememberInitialLiveMetadataVersion(payload?.metadata_version || live?.metadata_version);
      if (live) {
        setLiveData(current => current && !isEmptyLiveSnapshot(current) && isEmptyLiveSnapshot(live) ? current : live);
        setLoading(false);
      }
    };

    const loadSettings = (fresh = false) => {
      fetchPublicBootstrap({ ...(fresh ? { cache: 'reload' as const, cacheBust: true } : {}), includeHidden })
        .then((payload) => {
          if (!cancelled) {
            applyBootstrap(payload);
          }
        })
        .catch(() => fetchPublicSettings()
          .then((settings) => {
            if (!cancelled) {
              applySettings(settings);
            }
          })
          .catch(() => {
            if (!cancelled) {
              pollConfigRef.current = DEFAULT_LIVE_POLL_CONFIG;
              fallbackExpiresAtRef.current = null;
            }
          }));
    };

    const handleSettingsUpdated = (event: Event) => {
      if (cancelled) return;
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail && typeof detail === 'object') {
        applySettings(detail);
      } else {
        loadSettings();
      }
    };

    loadSettings();
    window.addEventListener(LIVE_POLL_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    const unsubscribePublicData = subscribePublicDataUpdated((detail) => {
      if (detail?.clients) return;
      clearCachedPublicBootstrap();
      clearCachedPublicSettings();
      loadSettings(true);
    });

    return () => {
      cancelled = true;
      window.removeEventListener(LIVE_POLL_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
      unsubscribePublicData();
    };
  }, [authLoading, enabled, includeHidden, viewer]);

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

    const connect = async () => {
      if (cancelled || typeof WebSocket === 'undefined') return;

      let viewerToken = '';
      try {
        const bootstrap = includeHidden ? null : getCachedPublicBootstrap();
        const live = normalizeLiveDataResponse(bootstrap?.live);
        rememberInitialLiveMetadataVersion(bootstrap?.metadata_version || live?.metadata_version);
        if (live) {
          setLiveData(current => current && !isEmptyLiveSnapshot(current) && isEmptyLiveSnapshot(live) ? current : live);
          setLoading(false);
        }
        const tokenResponse = await fetch('/api/ws/live-token');
        if (!tokenResponse.ok) throw new Error(`HTTP ${tokenResponse.status}`);
        const tokenData = normalizeViewerTokenResponse(await tokenResponse.json());
        if (!tokenData) throw new Error('Invalid live token response');
        viewerToken = tokenData.token;
        setViewerExpiresAt(tokenData.expires_at);
        setViewerExpired(false);
      } catch {
        ensureFallbackViewerWindow();
        void fetchLiveData();
        return;
      }
      if (cancelled || !viewerToken) return;

      const ws = new WebSocket(
        buildLiveWebSocketUrl(window.location.origin, `/api/ws/live${includeHidden ? '?include_hidden=1' : ''}`),
        buildLiveWebSocketProtocols(viewerToken),
      );
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (wsRef.current !== ws) return;
        wsOpenRef.current = true;
        setError(null);
        clearInitialSnapshotTimeout();
        initialSnapshotTimeoutRef.current = setTimeout(() => {
          if (!cancelled && wsRef.current === ws) {
            void fetchLiveData();
          }
        }, LIVE_WS_INITIAL_SNAPSHOT_TIMEOUT_MS);
      });

      ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (isSnapshotMessage(message)) {
            clearInitialSnapshotTimeout();
            const { type: _type, ...snapshot } = message;
            const normalized = normalizeLiveDataResponse(snapshot);
            if (!normalized) return;
            if (isEmptyLiveSnapshot(normalized)) {
              setLiveData(current => current && !isEmptyLiveSnapshot(current) ? current : normalized);
              setLoading(false);
              setError(null);
              void fetchLiveData();
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
            setLiveData(current => applyLiveUpdate(current, message));
            setLoading(false);
            setError(null);
            return;
          }
          if (isRemoveMessage(message)) {
            clearInitialSnapshotTimeout();
            setLiveData(current => applyLiveRemove(current, message));
            setLoading(false);
            return;
          }
          if (isViewerExpiredMessage(message)) {
            clearInitialSnapshotTimeout();
            reconnectLiveWebSocket();
            return;
          }
          if (isMetadataChangedMessage(message)) {
            if (message.websites) notifyWebsiteMonitorsUpdated(message.websites);
            notifyPublicDataUpdated(message.clients ? { clients: message.clients } : undefined);
            return;
          }
        } catch {
          // Ignore malformed live messages and let the HTTP fallback repair state.
        }
      });

      ws.addEventListener('error', () => {
        if (wsRef.current === ws) {
          clearInitialSnapshotTimeout();
          setError('Live WebSocket unavailable');
          void fetchLiveData();
        }
      });

      ws.addEventListener('close', () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        wsOpenRef.current = false;
        if (cancelled) return;
        clearInitialSnapshotTimeout();
        if (!wsExpiredRef.current) {
          void fetchLiveData();
        }
        clearReconnectTimeout();
        if (shouldReconnectLiveWebSocket({ expired: wsExpiredRef.current, hidden: document.hidden })) {
          reconnectTimeoutRef.current = setTimeout(
            () => { void connect(); },
            Math.min(30_000, pollConfigRef.current.idleIntervalMs),
          );
        }
      });
    };

    const reconnectLiveWebSocket = () => {
      wsOpenRef.current = false;
      wsExpiredRef.current = false;
      fallbackExpiresAtRef.current = null;
      setViewerExpired(false);
      setViewerExpiresAt(null);
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

    void connect();

    return () => {
      cancelled = true;
      clearReconnectTimeout();
      clearInitialSnapshotTimeout();
      wsOpenRef.current = false;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [authLoading, enabled, ensureFallbackViewerWindow, expireViewerSession, fetchLiveData, includeHidden, viewer]);

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
      const now = Date.now();
      if (activeSinceRef.current === null) {
        activeSinceRef.current = now;
      }
      const config = pollConfigRef.current;
      if (wsExpiredRef.current) {
        lastScheduledDelay = 0;
        lastScheduleWasIdle = true;
        return;
      }
      if (wsOpenRef.current) {
        lastScheduledDelay = config.idleIntervalMs;
        lastScheduleWasIdle = true;
        timeoutRef.current = setTimeout(poll, lastScheduledDelay);
        return;
      }
      const fallbackExpiresAt = wsOpenRef.current ? null : ensureFallbackViewerWindow(now);
      if (isViewerWindowExpired({ expiresAt: fallbackExpiresAt, now })) {
        expireViewerSession();
        lastScheduledDelay = 0;
        lastScheduleWasIdle = true;
        return;
      }
      lastScheduledDelay = getLivePollDelay({
        hidden: document.hidden,
        activeSince: activeSinceRef.current,
        now,
        config,
      });
      lastScheduleWasIdle = wsExpiredRef.current || wsOpenRef.current ||
        (activeSinceRef.current !== null && now - activeSinceRef.current >= config.activeMaxDurationMs);
      timeoutRef.current = setTimeout(poll, lastScheduledDelay);
    };

    const poll = async () => {
      if (polling || cancelled) return;
      if (wsOpenRef.current) {
        scheduleNextPoll();
        return;
      }
      const fallbackExpiresAt = wsOpenRef.current ? null : ensureFallbackViewerWindow();
      if (isViewerWindowExpired({ expiresAt: fallbackExpiresAt })) {
        expireViewerSession();
        return;
      }
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
      if (cancelled || wsExpiredRef.current || wsOpenRef.current) return;
      activeSinceRef.current = Date.now();
      void fetchLiveData();
    };

    const handleUserActivity = () => {
      if (cancelled) return;
      if (wsExpiredRef.current) return;
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
  }, [authLoading, enabled, ensureFallbackViewerWindow, expireViewerSession, fetchLiveData, viewer]);

  return (
    <LiveDataContext.Provider value={{ liveData, loading, error, viewerExpired, viewerExpiresAt, refresh }}>
      {children}
    </LiveDataContext.Provider>
  );
}
