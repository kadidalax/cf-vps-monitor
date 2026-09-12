import React, { useState, useEffect, useMemo } from 'react';
import { Flex, Text, Box } from '@radix-ui/themes';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, Globe2, RadioTower, Signal, UploadCloud } from 'lucide-react';
import { useLiveData } from '../contexts/LiveDataContext';
import { useAuth } from '../contexts/AuthContext';
import { ClientInfo, LiveDataMap } from '../types';
import { getNodeStatsSummary } from '../utils/monitorView';
import {
  buildDashboardStatusCards,
  defaultStatusCardVisibility,
  StatusCardKey,
} from '../utils/dashboardStatus';
import { fetchPublicBootstrap } from '../utils/publicBootstrap';
import { mergePublicClientPatch, normalizePublicClients } from '../utils/publicClients';
import { fetchWithBootstrapRetry } from '../utils/api';
import { getNodeDisplayRecord, getNodeLastReportTime, getNodeStatus } from '../utils/nodeMetrics';
import WebsiteMonitorList, { WebsiteMonitorSummary } from '../components/WebsiteMonitorList';
import { subscribeWebsiteMonitorsUpdated, type WebsiteMonitorsUpdateDetail } from '../utils/websiteMonitorEvents';
import { notifyPublicDataReady, subscribePublicDataUpdated } from '../utils/publicDataEvents';
import type { PublicDataUpdateDetail } from '../utils/publicDataEvents';

const NodeCard = React.lazy(() => import('../components/NodeCard'));
const NodeDisplay = React.lazy(() => import('../components/NodeDisplay'));

/* ========== Status Card Visibility (persisted in localStorage) ========== */
type StatusCardsVisibility = Record<StatusCardKey, boolean>;

const fallbackVisibility: StatusCardsVisibility = { ...defaultStatusCardVisibility };

export const nodeCardGridTemplateColumns = 'repeat(auto-fill, 320px)';
export const mobileNodeCardGridTemplateColumns = '1fr';

const nodeCardGridStyle = {
  '--node-card-grid-template-columns': nodeCardGridTemplateColumns,
  '--node-card-grid-template-columns-mobile': mobileNodeCardGridTemplateColumns,
} as React.CSSProperties;
const WEBSITE_MONITOR_REFRESH_MS = 120_000;
const WEBSITE_MONITOR_PERIODS = [1, 24, 72] as const;

const statusIconByKey: Record<StatusCardKey, React.ReactNode> = {
  currentOnline: <RadioTower size={18} />,
  regionOverview: <Globe2 size={18} />,
  trafficOverview: <UploadCloud size={18} />,
  networkSpeed: <Signal size={18} />,
};

function mergeLiveClientMetadata(clients: ClientInfo[], liveClients: LiveDataMap['clients'] = []): ClientInfo[] {
  const liveByUuid = new Map((liveClients || []).map((client) => [client.uuid, client]));
  return clients.map((client) => {
    const liveClient = liveByUuid.get(client.uuid);
    return liveClient?.region && !client.region ? { ...client, region: liveClient.region } : client;
  });
}

function applyPublicClientUpdate(current: ClientInfo[], detail: PublicDataUpdateDetail | undefined, includeHidden: boolean): ClientInfo[] {
  return mergePublicClientPatch(current, detail, { includeHidden });
}

function readWebsiteHidden(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

function normalizeWebsiteSummary(input: unknown, options: { includeHidden?: boolean } = {}): WebsiteMonitorSummary | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<WebsiteMonitorSummary> & { hidden?: unknown; hide_url?: unknown };
  const id = Number(value.id);
  const hidden = readWebsiteHidden(value.hidden);
  if (!Number.isInteger(id) || id <= 0 || (!options.includeHidden && hidden)) return null;
  return {
    id,
    name: String(value.name || ''),
    // Also defend against older tabs that still publish administrator rows.
    url: (!options.includeHidden && readWebsiteHidden(value.hide_url)) || value.url == null ? null : String(value.url),
    method: value.method === 'TCP' || value.method === 'HEAD' || value.method === 'GET' ? value.method : undefined,
    interval_sec: typeof value.interval_sec === 'number' ? value.interval_sec : 120,
    status: value.status === 'up' || value.status === 'down' || value.status === 'paused' ? value.status : 'pending',
    last_checked_at: typeof value.last_checked_at === 'string' ? value.last_checked_at : null,
    last_status_code: typeof value.last_status_code === 'number' ? value.last_status_code : null,
    last_raw_status_code: typeof value.last_raw_status_code === 'number' ? value.last_raw_status_code : null,
    last_latency_ms: typeof value.last_latency_ms === 'number' ? value.last_latency_ms : null,
    last_effective_reason: typeof value.last_effective_reason === 'string' ? value.last_effective_reason : null,
    hidden,
    checks: Array.isArray(value.checks) ? value.checks : [],
  };
}

function normalizeWebsiteSummaries(input: unknown, options: { includeHidden?: boolean } = {}): WebsiteMonitorSummary[] {
  return Array.isArray(input)
    ? input.map(item => normalizeWebsiteSummary(item, options)).filter((monitor): monitor is WebsiteMonitorSummary => Boolean(monitor))
    : [];
}

function applyWebsiteMonitorUpdate(
  current: WebsiteMonitorSummary[],
  detail?: WebsiteMonitorsUpdateDetail | true,
  options: { includeHidden?: boolean } = {},
): WebsiteMonitorSummary[] | null {
  if (!detail || detail === true) return null;
  const remove = new Set((detail.remove || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  const byId = new Map(current.filter((monitor) => !remove.has(monitor.id)).map((monitor) => [monitor.id, monitor]));
  for (const raw of detail.upsert || []) {
    const normalized = normalizeWebsiteSummary(raw, options);
    if (!normalized) {
      const id = Number((raw as { id?: unknown } | null)?.id);
      if (Number.isInteger(id) && id > 0) byId.delete(id);
      continue;
    }
    byId.set(normalized.id, { ...byId.get(normalized.id), ...normalized });
  }
  const next = [...byId.values()];
  if (detail.reorder?.length) {
    const order = new Map(detail.reorder.map((id, index) => [Number(id), index]));
    next.sort((a, b) => (order.get(a.id) ?? next.length) - (order.get(b.id) ?? next.length));
  }
  return next;
}

/* ========== Top Card ========== */
export function TopCard({
  title,
  value,
  detail,
  icon,
  oneLine,
  inlineValues,
  className = '',
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  oneLine?: boolean;
  inlineValues?: string[];
  className?: string;
}) {
  const hasInlineValues = Boolean(inlineValues?.length);

  return (
    <Box className={`monitor-stat-card${hasInlineValues ? ' has-inline-values' : ''}${className ? ` ${className}` : ''}`}>
      <Flex className="monitor-stat-card-inner" align="center" gap="2">
        <span className="monitor-stat-icon" aria-hidden="true">{icon}</span>
        <Box className="monitor-stat-copy">
          <Flex className="monitor-stat-heading-row" align="center" gap="2">
            <Text className="monitor-stat-title" size="2">{title}</Text>
            {inlineValues ? (
              <span className="monitor-stat-inline-values">
                {inlineValues.map((item) => (
                  <span
                    key={item}
                    className={`monitor-stat-inline-value${item.startsWith('↑') ? ' is-up' : item.startsWith('↓') ? ' is-down' : ''}`}
                  >
                    {item}
                  </span>
                ))}
              </span>
            ) : (
              <Text className="monitor-stat-value" size="5" weight="bold">
                {value}
              </Text>
            )}
          </Flex>
          {!oneLine && <Text className="monitor-stat-detail" size="1">{detail}</Text>}
        </Box>
      </Flex>
    </Box>
  );
}

export function ApiUnavailableNotice({ error }: { error: string }) {
  const showDetail = import.meta.env.DEV;
  return (
    <section className="monitor-api-alert" role="alert" aria-live="polite">
      <Flex align="start" gap="3">
        <span className="monitor-api-alert-icon" aria-hidden="true">
          <AlertTriangle size={18} />
        </span>
        <Box>
          <Text size="3" weight="bold" as="p">无法连接 Worker API</Text>
          <Text size="2" color="gray" as="p">
            请检查 Worker 是否已部署、Supabase Data API/RPC 是否已配置，以及本地开发时 Vite 是否正确代理到 Worker。
          </Text>
          {showDetail && (
            <Text size="1" color="gray" as="p" style={{ marginTop: 6, fontFamily: 'var(--font-mono, monospace)' }}>
              {error}
            </Text>
          )}
        </Box>
      </Flex>
    </section>
  );
}

export default function Index() {
  const location = useLocation();
  const { authLoading, isAuthenticated } = useAuth();
  const { liveData, error, snapshotReady, clientMetadata: clients, setClientMetadata: setClients } = useLiveData();
  const monitorMode = new URLSearchParams(location.search).get('view') === 'websites' ? 'websites' : 'servers';
  const [clientsLoading, setClientsLoading] = useState(clients === undefined);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [websites, setWebsites] = useState<WebsiteMonitorSummary[]>([]);
  const [websitesLoading, setWebsitesLoading] = useState(monitorMode === 'websites' && websites.length === 0);
  const [websitesError, setWebsitesError] = useState<string | null>(null);
  const [websitePeriodHours, setWebsitePeriodHours] = useState(24);
  // The public view always keeps offline nodes last, including older saved preferences.
  const offlinePosition = 'last';

  const handleWebsitePeriodChange = (hours: number) => {
    if (hours === websitePeriodHours) return;
    setWebsitesLoading(true);
    setWebsitePeriodHours(hours);
  };

  // Load client list
  useEffect(() => {
    let cancelled = false;
    let clientsRequest = 0;
    let pendingClientUpdates: PublicDataUpdateDetail[] | null = null;
    if (authLoading) {
      setClientsLoading(true);
      return () => {
        cancelled = true;
      };
    }
    if (monitorMode !== 'servers') {
      setClientsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setClientsLoading(true);

    const loadClients = (updates: PublicDataUpdateDetail[] = pendingClientUpdates ?? []) => {
      const request = ++clientsRequest;
      pendingClientUpdates = updates;
      const isCurrent = () => !cancelled && request === clientsRequest;
      fetchPublicBootstrap({ includeHidden: isAuthenticated })
        .then(data => {
          if (data.clients !== undefined) return data.clients;
          throw new Error('Bootstrap clients missing');
        })
        .catch((loadError: unknown) => {
          if (!isCurrent()) throw loadError;
          return fetchWithBootstrapRetry(`/api/clients${isAuthenticated ? '?include_hidden=1' : ''}`)
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            });
        })
        .then(data => {
          const clients = normalizePublicClients(data, { includeHidden: isAuthenticated });
          const listPayload = Array.isArray(data) ||
            (Boolean(data) && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data));
          if (listPayload || clients.length > 0) return clients;
          throw new Error('客户端列表格式无效');
        })
        .then(data => {
          if (isCurrent()) {
            setClients(updates.reduce((clients, update) => applyPublicClientUpdate(clients, update, isAuthenticated), data));
            setClientsError(null);
          }
        })
        .catch((loadError: unknown) => {
          if (isCurrent()) {
            setClientsError(loadError instanceof Error ? loadError.message : '客户端列表加载失败');
          }
        })
        .finally(() => {
          if (isCurrent()) {
            pendingClientUpdates = null;
            setClientsLoading(false);
            notifyPublicDataReady();
          }
        });
    };

    const loadWhenVisible = () => {
      // 名副其实：隐藏时不拉。visibilitychange 双向触发，切走那次同样要跳过；
      // 切回可见时该事件会再次触发，届时立刻补拉一次。
      if (document.hidden) return;
      loadClients();
    };
    const refreshPublicClients = (detail?: PublicDataUpdateDetail) => {
      setClients((current) => current === undefined ? undefined : applyPublicClientUpdate(current, detail, isAuthenticated));
      if (detail?.clients) {
        // A delta cannot replace the pending full list. Replay it after that
        // list arrives, including in the authorized view without public caching.
        pendingClientUpdates?.push(detail);
        return;
      }
      const request = ++clientsRequest;
      const updates: PublicDataUpdateDetail[] = [];
      pendingClientUpdates = updates;
      const isCurrent = () => !cancelled && request === clientsRequest;
      fetchPublicBootstrap({ cache: 'reload', cacheBust: true, includeHidden: isAuthenticated })
        .then(data => {
          if (data.clients === undefined) throw new Error('Bootstrap clients missing');
          if (isCurrent() && data.clients !== undefined) {
            const nextClients = data.clients;
            setClients(updates.reduce((clients, update) => applyPublicClientUpdate(clients, update, isAuthenticated), nextClients));
            setClientsError(null);
          }
        })
        .catch(() => { if (isCurrent()) loadClients(updates); })
        .finally(() => {
          if (isCurrent()) {
            pendingClientUpdates = null;
            setClientsLoading(false);
            notifyPublicDataReady();
          }
        });
    };

    loadClients();
    const unsubscribePublicData = subscribePublicDataUpdated(refreshPublicClients);
    document.addEventListener('visibilitychange', loadWhenVisible);
    const timer = window.setInterval(loadWhenVisible, 60_000);
    return () => {
      cancelled = true;
      unsubscribePublicData();
      document.removeEventListener('visibilitychange', loadWhenVisible);
      window.clearInterval(timer);
    };
  }, [authLoading, monitorMode, isAuthenticated, setClients]);

  useEffect(() => {
    let cancelled = false;
    if (authLoading) {
      setWebsitesLoading(monitorMode === 'websites');
      return () => {
        cancelled = true;
      };
    }
    if (monitorMode !== 'websites') {
      setWebsitesLoading(false);
      return () => {
        cancelled = true;
      };
    }

    let websiteRequest = 0;
    let pendingWebsiteUpdates: Array<WebsiteMonitorsUpdateDetail> | null = null;
    const loadWebsites = (fresh = false) => {
      const request = ++websiteRequest;
      const updates: Array<WebsiteMonitorsUpdateDetail> = [];
      pendingWebsiteUpdates = updates;
      const isCurrent = () => !cancelled && request === websiteRequest;
      setWebsitesLoading(true);
      const url = `/api/websites?hours=${websitePeriodHours}${isAuthenticated ? '&include_hidden=1' : ''}${fresh ? `&_fresh=${Date.now()}` : ''}`;
      fetchWithBootstrapRetry(url, fresh ? { cache: 'reload' } : undefined)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          if (!Array.isArray(data)) throw new Error('网站监控列表格式无效');
          const list = normalizeWebsiteSummaries(data, { includeHidden: isAuthenticated });
          if (!isCurrent()) return;
          setWebsites(updates.reduce((current, detail) => applyWebsiteMonitorUpdate(current, detail, { includeHidden: isAuthenticated }) || current, list));
          setWebsitesError(null);
        })
        .catch((loadError: unknown) => {
          if (isCurrent()) setWebsitesError(loadError instanceof Error ? loadError.message : '网站监控加载失败');
        })
        .finally(() => {
          if (isCurrent()) {
            pendingWebsiteUpdates = null;
            setWebsitesLoading(false);
          }
        });
    };

    const loadWhenVisible = () => {
      // 同上：隐藏时不拉，切回可见由 visibilitychange 补一次。
      if (document.hidden) return;
      loadWebsites(true);
    };

    loadWebsites(true);
    const unsubscribe = subscribeWebsiteMonitorsUpdated((detail) => {
      if (!detail || detail === true) {
        loadWebsites(true);
        return;
      }
      pendingWebsiteUpdates?.push(detail);
      setWebsites((current) => {
        const applied = applyWebsiteMonitorUpdate(current, detail, { includeHidden: isAuthenticated });
        if (!applied) return current;
        return applied;
      });
    });
    document.addEventListener('visibilitychange', loadWhenVisible);
    const timer = window.setInterval(loadWhenVisible, WEBSITE_MONITOR_REFRESH_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener('visibilitychange', loadWhenVisible);
      window.clearInterval(timer);
    };
  }, [authLoading, isAuthenticated, monitorMode, websitePeriodHours]);

  // Normalize live data for the LiveDataMap type
  const liveMap: LiveDataMap = useMemo(() => {
    if (!liveData) return { online: [], data: {}, last_known: {}, statusReady: false };
    return {
      online: liveData.online || [],
      data: liveData.data || {},
      clients: liveData.clients || [],
      last_known: liveData.last_known || {},
      statusReady: snapshotReady,
    };
  }, [liveData, snapshotReady]);

  const displayClients = mergeLiveClientMetadata(clients || [], liveMap.clients);

  const stats = useMemo(() => {
    return getNodeStatsSummary(displayClients, liveMap);
  }, [displayClients, liveMap]);

  const apiError = !clientsLoading ? (clientsError || error) : null;

  const statusCards = buildDashboardStatusCards(stats);

  const renderGrid = (nodes: ClientInfo[], ld: LiveDataMap) => (
    <Box className="node-card-grid" style={nodeCardGridStyle}>
      {nodes.map(client => (
        <NodeCard
          key={client.uuid}
          client={client}
          live={getNodeDisplayRecord(client.uuid, ld)}
          online={ld.online.includes(client.uuid)}
          status={getNodeStatus(client.uuid, ld)}
          lastReportTime={getNodeLastReportTime(client.uuid, ld)}
          includeHidden={isAuthenticated}
        />
      ))}
    </Box>
  );

  return (
    <div className="monitor-dashboard-page">
      {monitorMode === 'servers' && (
        <section className="monitor-dashboard-hero monitor-dashboard-compact">
          <div className="monitor-stat-grid">
            {statusCards.filter(card => fallbackVisibility[card.key]).map(card => (
              <TopCard
                key={card.key}
                title={card.title}
                value={snapshotReady && clients !== undefined ? card.value : '—'}
                detail={card.detail}
                icon={statusIconByKey[card.key]}
                oneLine={card.oneLine}
                inlineValues={snapshotReady && clients !== undefined ? card.inlineValues : undefined}
                className={card.key === 'currentOnline' ? 'is-centered' : ''}
              />
            ))}
          </div>
        </section>
      )}

      {apiError && <ApiUnavailableNotice error={apiError} />}

      {monitorMode === 'servers' ? (
        <React.Suspense fallback={null}>
          <NodeDisplay
            nodes={displayClients}
            liveData={liveMap}
            loading={clients === undefined && clientsLoading}
            dataAvailable={clients !== undefined}
            gridRenderer={renderGrid}
            offlinePosition={offlinePosition}
            includeHidden={isAuthenticated}
          />
        </React.Suspense>
      ) : (
        <section className="website-monitor-shell">
          {websitesError && <ApiUnavailableNotice error={websitesError} />}
          <WebsiteMonitorList monitors={websites} loading={websitesLoading} periodHours={websitePeriodHours} onPeriodChange={handleWebsitePeriodChange} periods={WEBSITE_MONITOR_PERIODS} />
        </section>
      )}
    </div>
  );
}
