import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Badge, Box, Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { Database, Gauge, HardDrive, RefreshCw, Save, Server } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { LIVE_POLL_SETTINGS_UPDATED_EVENT } from '../../contexts/livePolling';
import { SettingCard, SettingInput, SettingToggle } from '../../components/admin/SettingCard';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';
import { notifyPublicDataUpdated } from '../../utils/publicDataEvents';
import type { SettingsLayoutOutletContext } from './SettingsLayout';
import { buildResourceEstimates, type ResourceEstimate } from '../../../../worker/src/utils/capacity-estimate';
import CapacityResources from '../../components/admin/CapacityResources';

interface CapacityEstimate {
  clients: number;
  gpu_clients?: number;
  capacity_daily_view_minutes?: number;
  record_persist_interval_sec?: number;
  ping_record_persist_interval_sec?: number;
  record_high_watermark_rows?: number;
  record_high_watermark_bytes?: number;
  // Physical allocation is diagnostic; live data estimates drive the history budget.
  history_total_bytes?: number | null;
  history_storage_usage?: {
    estimated_live_storage_bytes: number;
    allocated_bytes: number;
    live_rows?: number;
    live_row_bytes?: number;
    reusable_bytes?: null;
    measurement?: string;
  } | null;
  resource_estimates?: ResourceEstimate[];
  active_monitor_records_per_day?: number;
  idle_monitor_records_per_day?: number;
  monitor_records_per_day?: number;
  active_gpu_snapshots_per_day?: number;
  idle_gpu_snapshots_per_day?: number;
  gpu_snapshots_per_day?: number;
  estimated_rows_retained?: number;
  estimated_storage_bytes?: number;
  estimated_gpu_snapshots_retained?: number;
  ping_records_per_day: number;
  total_estimated_business_rows_per_day?: number;
  capacity_count_checks_per_day?: number;
  ping_result_reports_per_day?: number;
  agent_ping_task_pulls_per_day?: number;
  agent_basic_info_reports_per_day?: number;
  agent_websocket_connects_per_day?: number;
  agent_websocket_messages_per_day?: number;
  cron_invocations_per_day?: number;
  admin_tour_worker_requests?: number;
  estimated_worker_requests_per_day?: number;
  estimated_durable_object_requests_per_day?: number;
  legacy_ping_records_per_day?: number;
  ping_records_saved_per_day?: number;
  ping_storage_mode?: string;
  ping_tasks?: Array<{
    id: number;
    name?: string;
    target_client_count?: number;
  }>;
  actual_row_counts?: {
    records?: number;
    gpu_records?: number;
    gpu_snapshots?: number;
    ping_records?: number;
    ping_snapshots?: number;
    audit_logs?: number;
  } | null;
  row_counts_capped?: Record<string, boolean> | null;
  row_counts_limit?: number | null;
  expired_row_counts?: {
    records?: number;
    gpu_records?: number;
    gpu_snapshots?: number;
    ping_records?: number;
    ping_snapshots?: number;
    audit_logs?: number;
  } | null;
  row_counts_checked_at?: string;
  row_counts_cache_seconds?: number;
  quota_reference?: {
    database?: {
      storage_bytes?: {
        free_project_reference?: number;
        pro_project_reference?: number;
        note?: string;
      };
      estimated_row_bytes?: {
        monitor_record?: number;
        gpu_snapshot?: number;
        ping_record?: number;
        ping_snapshot?: number;
      };
    };
    workers?: {
      requests?: {
        daily_free?: number;
        monthly_included?: number;
        comparison_month_days?: number;
      };
      requests_per_day?: {
        free?: number;
        paid_included?: number;
      };
    };
  };
}

const DEFAULT_RETENTION_HOURS = 72;
const MAX_RETENTION_HOURS = 72;
const DEFAULT_ACTIVE_SAMPLE_SEC = 3;
const DEFAULT_IDLE_UPLOAD_SEC = 120;
const MIN_IDLE_UPLOAD_SEC = 60;
const DEFAULT_VIEWER_TTL_SEC = 120;
const DEFAULT_RECORD_PERSIST_SEC = 120;
const DEFAULT_PING_RECORD_PERSIST_SEC = 120;
const DEFAULT_RECORD_HIGH_WATERMARK_ROWS = 700_000;
const DEFAULT_RECORD_HIGH_WATERMARK_BYTES = 419_430_400;
const DEFAULT_DAILY_VIEW_MINUTES = 60;
const DEFAULT_OFFLINE_CONFIRM_ROUNDS = 3;
const SUPABASE_FREE_DATABASE_STORAGE_REFERENCE_BYTES = 500 * 1024 * 1024;
const SUPABASE_PRO_DATABASE_STORAGE_REFERENCE_BYTES = 8 * 1024 * 1024 * 1024;
const ESTIMATED_MONITOR_RECORD_BYTES = 420;
const ESTIMATED_GPU_SNAPSHOT_BYTES = 420;
const ESTIMATED_PING_RECORD_BYTES = 160;
const ESTIMATED_PING_SNAPSHOT_BYTES = 220;
const WORKER_FREE_DAILY_REQUESTS = 100_000;
const WORKER_PAID_MONTHLY_REQUESTS = 10_000_000;
// 与 worker/wrangler.toml 的 crons 配置保持一致（每 2 分钟一次）：
// 定时任务是空闲基线的主要来源，实测约占 94%。
const CRON_INVOCATIONS_PER_DAY = 720;
const CAPACITY_COUNT_FAR_CHECK_SEC = 6 * 60 * 60;
const CAPACITY_COUNT_NEAR_CHECK_SEC = 10 * 60;
const CAPACITY_COUNT_CRITICAL_CHECK_SEC = 60;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function formatInteger(value: number | undefined): string {
  return Math.ceil(Number(value || 0)).toLocaleString();
}

function formatBytes(bytes: number | undefined): string {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  if (value < 0.1 && value > 0) return '<0.1%';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function getSettingValue(settings: SettingsMap, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
}

function normalizeGeneralSettings(settings: SettingsMap): SettingsMap {
  return { ...settings };
}

function getPercentTone(value: number): 'green' | 'amber' | 'red' {
  if (value >= 70) return 'red';
  if (value >= 45) return 'amber';
  return 'green';
}

function sumRowCounts(counts: CapacityEstimate['expired_row_counts']): number {
  if (!counts) return 0;
  return Number(counts.records || 0)
    + Number(counts.gpu_records || 0)
    + Number(counts.gpu_snapshots || 0)
    + Number(counts.ping_records || 0)
    + Number(counts.ping_snapshots || 0)
    + Number(counts.audit_logs || 0);
}

function dailySamplesPerClient(intervalSec: number): number {
  return intervalSec > 0 ? Math.ceil(86400 / intervalSec) : 0;
}

function estimateCapacityCountCheckIntervalSec(estimatedRows: number, highWatermarkRows: number): number {
  if (highWatermarkRows <= 0) return CAPACITY_COUNT_NEAR_CHECK_SEC;
  const ratio = estimatedRows / highWatermarkRows;
  if (ratio >= 0.95) return CAPACITY_COUNT_CRITICAL_CHECK_SEC;
  if (ratio >= 0.8) return CAPACITY_COUNT_NEAR_CHECK_SEC;
  return CAPACITY_COUNT_FAR_CHECK_SEC;
}

function inferPingCoveredClients(capacity: CapacityEstimate | null, clients: number, intervalSec: number): number {
  const pingTasks = capacity?.ping_tasks || [];
  if (clients <= 0 || pingTasks.length === 0) return 0;

  const aggregateReportsPerDay = Math.max(
    0,
    Number(capacity?.ping_result_reports_per_day || capacity?.ping_records_per_day || 0),
  );
  const rowsPerClient = dailySamplesPerClient(intervalSec);
  if (aggregateReportsPerDay > 0 && rowsPerClient > 0) {
    return Math.min(clients, Math.max(0, Math.round(aggregateReportsPerDay / rowsPerClient)));
  }

  const summedTaskTargets = pingTasks.reduce(
    (sum, task) => sum + Math.max(0, Number(task.target_client_count || 0)),
    0,
  );
  return Math.min(clients, summedTaskTargets);
}

function EstimateMetric({
  label,
  value,
  tone,
  density = 'medium',
}: {
  label: string;
  value: string;
  tone?: 'blue' | 'green' | 'amber' | 'orange' | 'red' | 'purple';
  density?: 'short' | 'medium' | 'long';
}) {
  return (
    <Flex direction="column" gap="1" className={`quota-estimate-metric quota-estimate-metric-${density}`} style={{ minWidth: 0 }}>
      <Text size="1" color="gray">{label}</Text>
      <Badge variant="soft" color={tone || 'gray'} style={{ width: 'fit-content' }}>{value}</Badge>
    </Flex>
  );
}

function QuotaBar({
  label,
  value,
  percent,
  caption,
  icon,
}: {
  label: string;
  value: string;
  percent: number;
  caption: string;
  icon: React.ReactNode;
}) {
  const known = Number.isFinite(percent);
  const clamped = known ? Math.max(0, Math.min(100, percent)) : 0;
  const tone = known ? getPercentTone(percent) : 'gray';

  return (
    <div className={`quota-estimate-card quota-estimate-card-${tone}`}>
      <Flex align="center" justify="between" gap="3">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <span className="quota-estimate-icon" aria-hidden="true">{icon}</span>
          <Flex direction="column" style={{ minWidth: 0 }}>
            <Text size="1" color="gray">{label}</Text>
            <Text size="3" weight="bold" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{value}</Text>
          </Flex>
        </Flex>
        <Badge variant="soft" color={tone}>{known ? formatPercent(percent) : '未知'}</Badge>
      </Flex>
      <div className="quota-estimate-track" aria-hidden="true">
        <div className="quota-estimate-fill" style={{ width: `${clamped}%` }} />
      </div>
      <Text size="1" color="gray">{caption}</Text>
    </div>
  );
}

export default function SettingsGeneral() {
  const apiFetch = useApi();
  const { setAction, settingsCache, loadSettingsScope, setSettingsScope } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>(() => normalizeGeneralSettings(settingsCache.general || {}));
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>(() => settingsCache.general || {});
  const [capacity, setCapacity] = useState<CapacityEstimate | null>(null);
  const [loading, setLoading] = useState(!settingsCache.general);
  const [settingsReady, setSettingsReady] = useState(Boolean(settingsCache.general));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [refreshingCounts, setRefreshingCounts] = useState(false);
  const [explainDialog, setExplainDialog] = useState<'cleanup' | 'refresh' | null>(null);

  const refreshCapacity = useCallback(async (forceCounts = false) => {
    const path = forceCounts ? '/admin/capacity?refresh_counts=true' : '/admin/capacity';
    try {
      const capacityData = await apiFetch(path);
      if (capacityData && typeof capacityData === 'object') {
        setCapacity(capacityData as CapacityEstimate);
        return true;
      }
    } catch {}
    return false;
  }, [apiFetch]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadSettingsScope('general')
      .then((settingsData) => {
        if (cancelled) return;
        setSettings(normalizeGeneralSettings(settingsData));
        setOriginalSettings(settingsData);
        setSettingsReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '读取设置失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadSettingsScope, reloadKey]);

  useEffect(() => {
    apiFetch('/admin/capacity')
      .then((capacityData) => {
        if (capacityData && typeof capacityData === 'object') setCapacity(capacityData as CapacityEstimate);
      })
      .catch(() => {});
  }, [apiFetch]);

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateRetentionHours = (value: string) => {
    setSettings((prev) => ({
      ...prev,
      record_preserve_time: value,
      ping_record_preserve_time: value,
    }));
  };

  const derived = useMemo(() => {
    const hasLocalCapacityEdits = [
      'record_enabled',
      'record_preserve_time',
      'ping_record_preserve_time',
      'live_poll_active_interval_sec',
      'live_poll_idle_interval_sec',
      'record_persist_interval_sec',
      'ping_record_persist_interval_sec',
      'record_high_watermark_rows',
      'record_high_watermark_bytes',
      'capacity_daily_view_minutes',
    ].some((key) => settings[key] !== originalSettings[key]);
    const clients = Math.max(0, Number(capacity?.clients || 0));
    const gpuClients = Math.max(0, Number(capacity?.gpu_clients || 0));
    const hasActualRowCounts = Boolean(capacity?.actual_row_counts);
    const hasExpiredRowCounts = Boolean(capacity?.expired_row_counts);
    const actualRows = sumRowCounts(capacity?.actual_row_counts);
    const cappedRowCounts = Object.values(capacity?.row_counts_capped || {}).some(Boolean);
    const expiredBacklogRows = hasExpiredRowCounts ? sumRowCounts(capacity?.expired_row_counts) : 0;
    const retentionHours = clampInteger(
      settings.record_preserve_time || settings.ping_record_preserve_time,
      DEFAULT_RETENTION_HOURS,
      1,
      MAX_RETENTION_HOURS,
    );
    const recordEnabled = settings.record_enabled !== 'false';
    const sampleIntervalSec = clampInteger(
      settings.live_poll_active_interval_sec,
      DEFAULT_ACTIVE_SAMPLE_SEC,
      3,
      300,
    );
    const idleUploadIntervalSec = clampInteger(
      settings.live_poll_idle_interval_sec,
      DEFAULT_IDLE_UPLOAD_SEC,
      MIN_IDLE_UPLOAD_SEC,
      3600,
    );
    const viewerTtlSec = clampInteger(
      settings.live_poll_active_max_duration_sec,
      DEFAULT_VIEWER_TTL_SEC,
      60,
      3600,
    );
    const recordPersistIntervalSec = clampInteger(
      settings.record_persist_interval_sec,
      Number(capacity?.record_persist_interval_sec || DEFAULT_RECORD_PERSIST_SEC),
      3,
      3600,
    );
    const pingRecordPersistIntervalSec = clampInteger(
      settings.ping_record_persist_interval_sec,
      Number(capacity?.ping_record_persist_interval_sec || DEFAULT_PING_RECORD_PERSIST_SEC),
      60,
      3600,
    );
    const capacityPingRecordPersistIntervalSec = clampInteger(
      capacity?.ping_record_persist_interval_sec,
      DEFAULT_PING_RECORD_PERSIST_SEC,
      60,
      3600,
    );
    const recordHighWatermarkRows = clampInteger(
      settings.record_high_watermark_rows,
      Number(capacity?.record_high_watermark_rows || DEFAULT_RECORD_HIGH_WATERMARK_ROWS),
      1000,
      10_000_000,
    );
    const recordHighWatermarkBytes = clampInteger(
      settings.record_high_watermark_bytes,
      Number(capacity?.record_high_watermark_bytes || DEFAULT_RECORD_HIGH_WATERMARK_BYTES),
      16_777_216,
      549_755_813_888,
    );
    const measuredLiveBytes = capacity?.history_storage_usage?.estimated_live_storage_bytes;
    const hasHistoryBytes = typeof measuredLiveBytes === 'number' && Number.isFinite(measuredLiveBytes) && measuredLiveBytes >= 0;
    const historyLiveBytes = hasHistoryBytes ? measuredLiveBytes : 0;
    const measuredAllocatedBytes = capacity?.history_storage_usage?.allocated_bytes ?? capacity?.history_total_bytes;
    const hasAllocatedBytes = typeof measuredAllocatedBytes === 'number' && Number.isFinite(measuredAllocatedBytes) && measuredAllocatedBytes >= 0;
    const historyAllocatedBytes = hasAllocatedBytes ? measuredAllocatedBytes : 0;
    const dailyViewMinutes = clampInteger(
      settings.capacity_daily_view_minutes,
      Number(capacity?.capacity_daily_view_minutes || DEFAULT_DAILY_VIEW_MINUTES),
      0,
      1440,
    );

    const activeSecondsPerDay = dailyViewMinutes * 60;
    const idleSecondsPerDay = Math.max(0, 86400 - activeSecondsPerDay);
    const activePersistIntervalSec = Math.max(sampleIntervalSec, recordPersistIntervalSec);
    const idlePersistIntervalSec = Math.max(idleUploadIntervalSec, recordPersistIntervalSec);
    const localActiveMonitorWritesPerDay = recordEnabled && activeSecondsPerDay > 0
      ? Math.ceil(clients * activeSecondsPerDay / activePersistIntervalSec)
      : 0;
    const localIdleMonitorWritesPerDay = recordEnabled && idleSecondsPerDay > 0
      ? Math.ceil(clients * idleSecondsPerDay / idlePersistIntervalSec)
      : 0;
    const localMonitorWritesPerDay = localActiveMonitorWritesPerDay + localIdleMonitorWritesPerDay;
    const localActiveGpuWritesPerDay = recordEnabled && activeSecondsPerDay > 0
      ? Math.ceil(gpuClients * activeSecondsPerDay / activePersistIntervalSec)
      : 0;
    const localIdleGpuWritesPerDay = recordEnabled && idleSecondsPerDay > 0
      ? Math.ceil(gpuClients * idleSecondsPerDay / idlePersistIntervalSec)
      : 0;
    const localGpuSnapshotsPerDay = localActiveGpuWritesPerDay + localIdleGpuWritesPerDay;
    const activeMonitorWritesPerDay = hasLocalCapacityEdits
      ? localActiveMonitorWritesPerDay
      : Math.max(localActiveMonitorWritesPerDay, Number(capacity?.active_monitor_records_per_day || 0));
    const idleMonitorWritesPerDay = hasLocalCapacityEdits
      ? localIdleMonitorWritesPerDay
      : Math.max(localIdleMonitorWritesPerDay, Number(capacity?.idle_monitor_records_per_day || 0));
    const monitorWritesPerDay = hasLocalCapacityEdits
      ? localMonitorWritesPerDay
      : Math.max(localMonitorWritesPerDay, Number(capacity?.monitor_records_per_day || 0));
    const activeGpuWritesPerDay = hasLocalCapacityEdits
      ? localActiveGpuWritesPerDay
      : Math.max(localActiveGpuWritesPerDay, Number(capacity?.active_gpu_snapshots_per_day || 0));
    const idleGpuWritesPerDay = hasLocalCapacityEdits
      ? localIdleGpuWritesPerDay
      : Math.max(localIdleGpuWritesPerDay, Number(capacity?.idle_gpu_snapshots_per_day || 0));
    const gpuSnapshotsPerDay = hasLocalCapacityEdits
      ? localGpuSnapshotsPerDay
      : Math.max(localGpuSnapshotsPerDay, Number(capacity?.gpu_snapshots_per_day || 0));
    const pingCoveredClients = inferPingCoveredClients(capacity, clients, capacityPingRecordPersistIntervalSec);
    const pingRowsPerClientPerDay = dailySamplesPerClient(pingRecordPersistIntervalSec);
    const localPingRowsPerDay = recordEnabled
      ? pingCoveredClients * pingRowsPerClientPerDay
      : 0;
    const localPingResultReportsPerDay = pingCoveredClients * pingRowsPerClientPerDay;
    const pingRowsPerDay = hasLocalCapacityEdits
      ? localPingRowsPerDay
      : Math.max(localPingRowsPerDay, Number(capacity?.ping_records_per_day || 0));
    const pingResultReportsPerDay = hasLocalCapacityEdits
      ? localPingResultReportsPerDay
      : Math.max(localPingResultReportsPerDay, Number(capacity?.ping_result_reports_per_day || 0));
    const estimatedMonitorRowsRetained = Math.ceil(monitorWritesPerDay * retentionHours / 24);
    const estimatedGpuRowsRetained = Math.ceil(gpuSnapshotsPerDay * retentionHours / 24);
    const estimatedPingRowsRetained = Math.ceil(pingRowsPerDay * retentionHours / 24);
    const localEstimatedRowsRetained = estimatedMonitorRowsRetained + estimatedGpuRowsRetained + estimatedPingRowsRetained;
    const freeStorageBytes = capacity?.quota_reference?.database?.storage_bytes?.free_project_reference ||
      SUPABASE_FREE_DATABASE_STORAGE_REFERENCE_BYTES;
    const monitorRecordBytes = capacity?.quota_reference?.database?.estimated_row_bytes?.monitor_record ||
      ESTIMATED_MONITOR_RECORD_BYTES;
    const gpuSnapshotBytes = capacity?.quota_reference?.database?.estimated_row_bytes?.gpu_snapshot ||
      ESTIMATED_GPU_SNAPSHOT_BYTES;
    const pingRecordBytes = capacity?.quota_reference?.database?.estimated_row_bytes?.ping_snapshot ||
      capacity?.quota_reference?.database?.estimated_row_bytes?.ping_record ||
      (capacity?.ping_storage_mode === 'snapshots' ? ESTIMATED_PING_SNAPSHOT_BYTES : ESTIMATED_PING_RECORD_BYTES);
    const localEstimatedStorageBytes = estimatedMonitorRowsRetained * monitorRecordBytes
      + estimatedGpuRowsRetained * gpuSnapshotBytes
      + estimatedPingRowsRetained * pingRecordBytes;
    const estimatedRowsRetained = hasLocalCapacityEdits
      ? localEstimatedRowsRetained
      : Math.max(localEstimatedRowsRetained, Number(capacity?.estimated_rows_retained || 0));
    const estimatedStorageBytes = hasLocalCapacityEdits
      ? localEstimatedStorageBytes
      : Math.max(localEstimatedStorageBytes, Number(capacity?.estimated_storage_bytes || 0));
    const supabaseProStorageReferenceBytes = capacity?.quota_reference?.database?.storage_bytes?.pro_project_reference ||
      SUPABASE_PRO_DATABASE_STORAGE_REFERENCE_BYTES;
    const workerFreeDailyRequests = capacity?.quota_reference?.workers?.requests?.daily_free || capacity?.quota_reference?.workers?.requests_per_day?.free ||
      WORKER_FREE_DAILY_REQUESTS;
    const workerPaidMonthlyRequests = capacity?.quota_reference?.workers?.requests?.monthly_included || WORKER_PAID_MONTHLY_REQUESTS;
    const comparisonMonthDays = capacity?.quota_reference?.workers?.requests?.comparison_month_days || 30;
    const localHistoryRowsPerDay = monitorWritesPerDay + gpuSnapshotsPerDay + pingRowsPerDay;
    const historyRowsPerDay = hasLocalCapacityEdits
      ? localHistoryRowsPerDay
      : Math.max(localHistoryRowsPerDay, Number(capacity?.total_estimated_business_rows_per_day || 0));
    const hasPingTasks = (capacity?.ping_tasks || []).length > 0;
    const localAgentPingTaskPullsPerDay = Math.ceil(
      clients * 86400 / (hasPingTasks ? pingRecordPersistIntervalSec : 600),
    );
    const agentPingTaskPullsPerDay = hasLocalCapacityEdits
      ? localAgentPingTaskPullsPerDay
      : Math.max(localAgentPingTaskPullsPerDay, Number(capacity?.agent_ping_task_pulls_per_day || 0));
    const agentBasicInfoReportsPerDay = Math.max(
      0,
      Number(capacity?.agent_basic_info_reports_per_day || clients * 48),
    );
    const agentWebsocketConnectsPerDay = Math.max(
      0,
      Number(capacity?.agent_websocket_connects_per_day || clients),
    );
    const pingTaskStateWritesPerDay = recordEnabled ? (capacity?.ping_tasks || []).reduce(
      (sum, task) => sum + Math.ceil(Math.max(0, Number(task.target_client_count || 0)) * 86400 / pingRecordPersistIntervalSec), 0,
    ) : 0;
    const resourcePreview = buildResourceEstimates({
      clientCount: clients, activeSecondsPerDay, sampleIntervalSec,
      idleIntervalSec: idleUploadIntervalSec, monitorRecordsPerDay: monitorWritesPerDay,
      pingTaskStateWritesPerDay, pingTaskPullsPerDay: agentPingTaskPullsPerDay,
      pingResultReportsPerDay, basicInfoReportsPerDay: agentBasicInfoReportsPerDay,
      connectionsPerDay: agentWebsocketConnectsPerDay, cronInvocationsPerDay: CRON_INVOCATIONS_PER_DAY,
      estimatedSupabaseStorageBytes: estimatedStorageBytes,
    });
    const resourceEstimates = !hasLocalCapacityEdits && Array.isArray(capacity?.resource_estimates)
      ? capacity.resource_estimates : resourcePreview.resource_estimates;
    const mixedWorkerRequestsPerDay = resourceEstimates.find(row => row.key === 'worker_requests')?.websocket ?? resourcePreview.estimated_worker_requests_per_day;
    const mixedDurableObjectRequestsPerDay = resourceEstimates.find(row => row.key === 'durable_object_requests')?.websocket ?? resourcePreview.estimated_durable_object_requests_per_day;
    const mixedWorkerRequestsPerMonth = mixedWorkerRequestsPerDay * comparisonMonthDays;
    const freeTierExceeded = resourceEstimates.some(row => row.within_free_websocket === false || row.within_free_http === false);
    const capacityCountCheckIntervalSec = recordEnabled
      ? estimateCapacityCountCheckIntervalSec(estimatedRowsRetained, recordHighWatermarkRows)
      : 0;
    const capacityCountChecksPerDay = recordEnabled && capacityCountCheckIntervalSec > 0
      ? Math.ceil(86400 / capacityCountCheckIntervalSec)
      : 0;

    return {
      clients,
      gpuClients,
      gpuWritesPerDay: gpuSnapshotsPerDay,
      pingWritesPerDay: pingRowsPerDay,
      pingRowsPerDay,
      actualRows,
      cappedRowCounts,
      hasActualRowCounts,
      hasExpiredRowCounts,
      expiredBacklogRows,
      retentionHours,
      sampleIntervalSec,
      idleUploadIntervalSec,
      viewerTtlSec,
      recordPersistIntervalSec,
      pingRecordPersistIntervalSec,
      recordHighWatermarkRows,
      dailyViewMinutes,
      activeSecondsPerDay,
      idleSecondsPerDay,
      monitorWritesPerDay,
      activeMonitorWritesPerDay,
      idleMonitorWritesPerDay,
      activeGpuWritesPerDay,
      idleGpuWritesPerDay,
      pingCoveredClients,
      agentPingTaskPullsPerDay,
      pingResultReportsPerDay,
      agentBasicInfoReportsPerDay,
      agentWebsocketConnectsPerDay,
      capacityCountChecksPerDay,
      historyRowsPerDay,
      estimatedRowsRetained,
      estimatedStorageBytes,
      highWatermarkPercent: estimatedRowsRetained / recordHighWatermarkRows * 100,
      recordHighWatermarkBytes,
      historyLiveBytes,
      historyAllocatedBytes,
      hasAllocatedBytes,
      hasHistoryBytes,
      highWatermarkBytesPercent: hasHistoryBytes
        ? historyLiveBytes / recordHighWatermarkBytes * 100
        : Number.NaN,
      storagePercent: estimatedStorageBytes / freeStorageBytes * 100,
      freeStorageBytes,
      supabaseProStorageReferenceBytes,
      workerFreeDailyRequests,
      workerPaidMonthlyRequests,
      comparisonMonthDays,
      resourceEstimates,
      freeTierExceeded,
      mixedWorkerRequestsPerDay,
      mixedWorkerRequestsPerMonth,
      mixedDurableObjectRequestsPerDay,
      mixedWorkerPercent: mixedWorkerRequestsPerDay / workerFreeDailyRequests * 100,
      mixedPaidWorkerPercent: mixedWorkerRequestsPerMonth / workerPaidMonthlyRequests * 100,
    };
  }, [capacity, originalSettings, settings]);

  const handleSave = useCallback(async () => {
    if (!settingsReady || loading || loadError || saving) return;
    const payload = {
      ...settings,
      record_preserve_time: String(derived.retentionHours),
      ping_record_preserve_time: String(derived.retentionHours),
      live_poll_active_interval_sec: String(derived.sampleIntervalSec),
      live_poll_idle_interval_sec: String(derived.idleUploadIntervalSec),
      live_poll_active_max_duration_sec: String(derived.viewerTtlSec),
      record_persist_interval_sec: String(derived.recordPersistIntervalSec),
      ping_record_persist_interval_sec: String(derived.pingRecordPersistIntervalSec),
      record_high_watermark_rows: String(derived.recordHighWatermarkRows),
      capacity_daily_view_minutes: String(derived.dailyViewMinutes),
    };
    const changedSettings = getChangedSettings(payload, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        setSettings(payload);
        setOriginalSettings(payload);
        setSettingsScope('general', payload);
        window.dispatchEvent(new CustomEvent(LIVE_POLL_SETTINGS_UPDATED_EVENT, { detail: payload }));
        notifyPublicDataUpdated();
        toast.success('设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, derived, originalSettings, setSettingsScope, settings, settingsReady, loading, loadError, saving]);

  const handleMaintenanceCleanup = useCallback(async () => {
    setCleaning(true);
    try {
      const result = await apiFetch('/admin/maintenance/cleanup', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.success) {
        const deleted = result.deleted || {};
        const totalDeleted = ['records', 'gpu_records', 'gpu_snapshots', 'ping_records', 'ping_snapshots', 'website_checks', 'audit_logs']
          .reduce((sum, key) => sum + Number(deleted[key] || 0), 0);
        if (result.has_more) toast.info(`已清理一批，删除 ${formatInteger(totalDeleted)} 行历史数据；仍有过期记录，可继续清理`);
        else toast.success(`维护清理完成，删除 ${formatInteger(totalDeleted)} 行历史数据`);
        await refreshCapacity(true);
      } else {
        toast.error(result.error || '维护清理失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '维护清理失败');
    } finally {
      setCleaning(false);
    }
  }, [apiFetch, refreshCapacity]);

  const handleRefreshActualRows = useCallback(async () => {
    setRefreshingCounts(true);
    try {
      const refreshed = await refreshCapacity(true);
      if (refreshed) {
        toast.success('实际行数已刷新');
      } else {
        toast.error('实际行数刷新失败');
      }
    } finally {
      setRefreshingCounts(false);
    }
  }, [refreshCapacity]);

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={!settingsReady || loading || Boolean(loadError) || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, settingsReady, loading, loadError, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  if (loading) return <Loading />;

  const loadFailure = loadError && <Flex align="center" gap="2">
    <Text color="red" role="alert">读取设置失败：{loadError}</Text>
    <Button variant="soft" onClick={() => setReloadKey(value => value + 1)}>重试</Button>
  </Flex>;
  if (!settingsReady) return loadFailure;

  return (
    <Flex direction="column" gap="4">
      {loadFailure}
      <SettingCard title="采集与记录策略" description="统一设置 Agent 采集、历史记录、存储水位与 Worker 用量估算" defaultOpen>
        <div className="general-settings-workspace">
          <section className="general-settings-manual-panel" aria-labelledby="general-settings-manual-title">
            <Flex align="center" justify="between" gap="2" wrap="wrap" className="general-settings-section-heading">
              <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
                <Text id="general-settings-manual-title" size="2" weight="bold">手动设置</Text>
                <Text size="1" color="gray">这些输入会即时驱动右侧用量估算，保存后同步给 Agent。</Text>
              </Flex>
              <Badge variant="soft" color="blue">可编辑</Badge>
            </Flex>

            <div className="general-settings-input-grid">
              <div className="general-setting-span-full general-setting-toggle-row">
                <SettingToggle
                  label="启用数据记录"
                  description="关闭后不再写入历史记录，但不影响实时数据展示"
                  checked={settings.record_enabled !== 'false'}
                  onCheckedChange={(checked) => updateSetting('record_enabled', checked ? 'true' : 'false')}
                />
              </div>
              <SettingInput
                label="历史保留时长（小时）"
                description="超过该时长的历史记录会被定时清理。上限 72 小时（3 天），填更大的值也会被截断；同时作用于监控历史与 Ping 历史"
                value={getSettingValue(settings, 'record_preserve_time', getSettingValue(settings, 'ping_record_preserve_time', String(DEFAULT_RETENTION_HOURS)))}
                onChange={updateRetentionHours}
                type="number"
                placeholder="72"
                width="100%"
              />
              <SettingInput
                label="每日预计观看时长（分钟）"
                description="仅用于下方的用量估算，不影响任何实际行为。按你每天大约打开前台看多久填写"
                value={getSettingValue(settings, 'capacity_daily_view_minutes', String(DEFAULT_DAILY_VIEW_MINUTES))}
                onChange={(value) => updateSetting('capacity_daily_view_minutes', value)}
                type="number"
                placeholder="60"
                width="100%"
              />

              <SettingInput
                label="有人观看时 · 上报间隔（秒）"
                description="前台有访客在看时，Agent 每隔多久采集并上报一次。只在有人看的时候生效，越小越实时"
                value={getSettingValue(settings, 'live_poll_active_interval_sec', String(DEFAULT_ACTIVE_SAMPLE_SEC))}
                onChange={(value) => updateSetting('live_poll_active_interval_sec', value)}
                type="number"
                placeholder="3"
                width="100%"
              />
              <SettingInput
                label="无人观看时 · 上报间隔（秒）"
                description="没有访客在看时的上报间隔，最少 60 秒。绝大多数时间跑的是这一档，它才是实际的采集频率；当前每次上报 1 条，不打包"
                value={getSettingValue(settings, 'live_poll_idle_interval_sec', String(DEFAULT_IDLE_UPLOAD_SEC))}
                onChange={(value) => updateSetting('live_poll_idle_interval_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="观看状态保持时长（秒）"
                description="访客离开页面后，仍按「有人观看」的高频维持多久才降回低频。避免刷新页面时频繁切换档位，与连接本身的保活无关"
                value={getSettingValue(settings, 'live_poll_active_max_duration_sec', String(DEFAULT_VIEWER_TTL_SEC))}
                onChange={(value) => updateSetting('live_poll_active_max_duration_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="历史落库最小间隔（秒）"
                description="两次写入历史之间至少要隔多久，是一道节流下限而非固定频率。实际写入频率 = 本项与上方「上报间隔」中较大的那个——比它小的设置不会生效"
                value={getSettingValue(settings, 'record_persist_interval_sec', String(DEFAULT_RECORD_PERSIST_SEC))}
                onChange={(value) => updateSetting('record_persist_interval_sec', value)}
                type="number"
                placeholder="30"
                width="100%"
              />
              <SettingInput
                label="Ping 探测与落库间隔（秒）"
                description="Agent 执行延迟探测的间隔，同时也是 Ping 记录写入历史的间隔；最低 60 秒。与上面的监控落库间隔互相独立"
                value={getSettingValue(settings, 'ping_record_persist_interval_sec', String(DEFAULT_PING_RECORD_PERSIST_SEC))}
                onChange={(value) => updateSetting('ping_record_persist_interval_sec', value)}
                type="number"
                placeholder="120"
                width="100%"
              />
              <SettingInput
                label="历史有效数据预算（字节）"
                description="当前有效历史数据及索引预留的估算达到该值后暂停历史写入，实时展示继续。它不等于物理文件大小；默认 400MiB，给其他数据留余量"
                value={getSettingValue(settings, 'record_high_watermark_bytes', String(DEFAULT_RECORD_HIGH_WATERMARK_BYTES))}
                onChange={(value) => updateSetting('record_high_watermark_bytes', value)}
                type="number"
                placeholder="419430400"
                width="100%"
              />
              <SettingInput
                label="历史写入熔断行数（行）"
                description="次要熔断线，与容量熔断谁先到谁生效。行数只是容量的粗糙代理且不含索引开销，一般不需要改动"
                value={getSettingValue(settings, 'record_high_watermark_rows', String(DEFAULT_RECORD_HIGH_WATERMARK_ROWS))}
                onChange={(value) => updateSetting('record_high_watermark_rows', value)}
                type="number"
                placeholder="700000"
                width="100%"
              />
              <SettingInput
                label="离线确认轮数（轮）"
                description="连续多少轮判定为离线才真正发出告警，任意一轮判定在线立即清零。定时任务每 2 分钟一轮，默认 3 轮约等于持续 6 分钟离线才告警，用于挡掉瞬时抖动造成的误报"
                value={getSettingValue(settings, 'offline_confirm_rounds', String(DEFAULT_OFFLINE_CONFIRM_ROUNDS))}
                onChange={(value) => updateSetting('offline_confirm_rounds', value)}
                type="number"
                placeholder="3"
                width="100%"
              />
            </div>
          </section>

          <section className="general-settings-calculated-panel" aria-labelledby="general-settings-calculated-title">
            <Box className="quota-estimate-panel quota-estimate-panel-embedded">
              <Flex align="start" justify="between" gap="3" wrap="wrap" mb="3">
                <Flex direction="column" gap="1" style={{ minWidth: 0, flex: '1 1 360px' }}>
                  <Flex align="center" gap="2">
                    <Gauge size={16} />
                    <Text id="general-settings-calculated-title" size="2" weight="bold">用量实时估算</Text>
                  </Flex>
                  <Text size="1" color="gray" className="quota-reference-line">
                    历史存储按 Supabase 项目容量估算；Worker Free {formatInteger(derived.workerFreeDailyRequests)}/天，Paid {formatInteger(derived.workerPaidMonthlyRequests)}/月；月度按 {derived.comparisonMonthDays} 天比较。
                  </Text>
                </Flex>
                <Flex align="center" gap="2" wrap="wrap" className="quota-estimate-actions">
                  <Badge variant="soft" color={derived.freeTierExceeded ? 'red' : getPercentTone(Math.max(derived.storagePercent, derived.highWatermarkPercent, derived.mixedWorkerPercent))}>
                    当前输入即时估算
                  </Badge>
                  <Button size="1" variant="soft" onClick={() => setExplainDialog('cleanup')} disabled={cleaning}>
                    <Database size={13} /> {cleaning ? '清理中…' : '维护清理'}
                  </Button>
                  <Button size="1" variant="soft" onClick={() => setExplainDialog('refresh')} disabled={refreshingCounts}>
                    <RefreshCw size={13} /> {refreshingCounts ? '刷新中…' : '刷新实际行数'}
                  </Button>
                </Flex>
              </Flex>
              <div className="quota-estimate-bar-grid">
                <QuotaBar
                  label="保留策略预计存储"
                  value={formatBytes(derived.estimatedStorageBytes)}
                  percent={derived.storagePercent}
                  caption={`Supabase Free 存储参考 ${formatBytes(derived.freeStorageBytes)}，Pro 参考 ${formatBytes(derived.supabaseProStorageReferenceBytes)}`}
                  icon={<Database size={15} />}
                />
                <QuotaBar
                  label="当前有效数据预算（估算）"
                  value={derived.hasHistoryBytes
                    ? `${formatBytes(derived.historyLiveBytes)} / ${formatBytes(derived.recordHighWatermarkBytes)}`
                    : `— / ${formatBytes(derived.recordHighWatermarkBytes)}`}
                  percent={derived.highWatermarkBytesPercent}
                  caption={derived.hasHistoryBytes
                    ? '有效历史数据与索引预留估算；达到后暂停历史写入。物理分配单独显示'
                    : '有效数据估算暂未读取；不能用物理文件大小代替'}
                  icon={<Database size={15} />}
                />
                <QuotaBar
                  label="历史高水位"
                  value={`${formatInteger(derived.estimatedRowsRetained)} / ${formatInteger(derived.recordHighWatermarkRows)}`}
                  percent={derived.highWatermarkPercent}
                  caption="次要熔断线，与容量熔断谁先到谁生效"
                  icon={<HardDrive size={15} />}
                />
                <QuotaBar
                  label="Worker Free"
                  value={formatInteger(derived.mixedWorkerRequestsPerDay)}
                  percent={derived.mixedWorkerPercent}
                  caption={`Free 参考 ${formatInteger(derived.workerFreeDailyRequests)} 请求/天`}
                  icon={<Server size={15} />}
                />
                <QuotaBar
                  label="Worker Paid"
                  value={formatInteger(derived.mixedWorkerRequestsPerMonth)}
                  percent={derived.mixedPaidWorkerPercent}
                  caption={`按 ${derived.comparisonMonthDays} 天预计；Paid 包含 ${formatInteger(derived.workerPaidMonthlyRequests)} 请求/月，超出另计费`}
                  icon={<Server size={15} />}
                />
              </div>
              <CapacityResources resources={derived.resourceEstimates} comparisonMonthDays={derived.comparisonMonthDays} />
              <Text as="p" size="1" color="gray">
                历史表物理分配：{derived.hasAllocatedBytes ? formatBytes(derived.historyAllocatedBytes) : '未读取'}。删除后未必缩小；可复用空间尚无法精确测量。平台实际配额以 Supabase 控制台为准。
              </Text>
              <div className="quota-estimate-metric-grid">
                <div className="quota-estimate-metric-column quota-estimate-metric-column-short">
                  <EstimateMetric label="节点数" value={formatInteger(derived.clients)} density="short" />
                  <EstimateMetric label="GPU 节点" value={formatInteger(derived.gpuClients)} density="short" />
                  <EstimateMetric label="历史行/天" value={formatInteger(derived.historyRowsPerDay)} tone="green" density="short" />
                  <EstimateMetric label="监控行/天" value={formatInteger(derived.monitorWritesPerDay)} tone="green" density="short" />
                  <EstimateMetric
                    label={derived.cappedRowCounts ? '计数下限' : '计数行数'}
                    value={derived.hasActualRowCounts ? `${derived.cappedRowCounts ? '>=' : ''}${formatInteger(derived.actualRows)}` : '未刷新'}
                    tone={derived.cappedRowCounts ? 'amber' : derived.hasActualRowCounts ? 'green' : 'blue'}
                    density="short"
                  />
                  <EstimateMetric label="保留时间" value={`${derived.retentionHours} 小时`} density="short" />
                  <EstimateMetric label="Ping 间隔" value={`${derived.pingRecordPersistIntervalSec} 秒`} density="short" />
                </div>
                <div className="quota-estimate-metric-column quota-estimate-metric-column-medium">
                  <EstimateMetric label="每日观看时间" value={`${derived.dailyViewMinutes} 分钟`} tone="blue" />
                  <EstimateMetric label="GPU 快照/天" value={formatInteger(derived.gpuWritesPerDay)} tone="green" />
                  <EstimateMetric label="Ping 快照/天" value={formatInteger(derived.pingWritesPerDay)} tone="green" />
                  <EstimateMetric label="容量检查/天" value={`${formatInteger(derived.capacityCountChecksPerDay)} 次`} tone="purple" />
                  <EstimateMetric label="经验保留行数" value={formatInteger(derived.estimatedRowsRetained)} tone="purple" />
                  <EstimateMetric label="历史高水位" value={`${formatInteger(derived.recordHighWatermarkRows)} 行`} tone={getPercentTone(derived.highWatermarkPercent) === 'red' ? 'red' : 'blue'} />
                  <EstimateMetric
                    label="过期待清理"
                    value={derived.hasExpiredRowCounts ? formatInteger(derived.expiredBacklogRows) : '未刷新'}
                    tone={derived.hasExpiredRowCounts && derived.expiredBacklogRows > 0 ? 'amber' : 'green'}
                  />
                </div>
                <div className="quota-estimate-metric-column quota-estimate-metric-column-long">
                  <EstimateMetric label="Worker 请求/天" value={formatInteger(derived.mixedWorkerRequestsPerDay)} tone="blue" density="long" />
                  <EstimateMetric label="Agent 任务拉取/天" value={formatInteger(derived.agentPingTaskPullsPerDay)} tone="blue" density="long" />
                  <EstimateMetric label="Ping 结果上报/天" value={formatInteger(derived.pingResultReportsPerDay)} tone="blue" density="long" />
                  <EstimateMetric label="基础信息上报/天" value={formatInteger(derived.agentBasicInfoReportsPerDay)} tone="blue" density="long" />
                  <EstimateMetric label="WebSocket 连接/天" value={formatInteger(derived.agentWebsocketConnectsPerDay)} tone="blue" density="long" />
                  <EstimateMetric label="历史写入间隔" value={`${derived.recordPersistIntervalSec} 秒`} density="long" />
                  <EstimateMetric label="无人打包间隔" value={`${derived.idleUploadIntervalSec} 秒`} density="long" />
                </div>
              </div>
              <Text size="1" color="gray" style={{ display: 'block', marginTop: 8 }}>
                保存时会按允许范围校验并归一化；现在不再按数据库读写配额估算，主要关注 Worker 请求量和 Supabase 历史存储增长。
                {capacity?.row_counts_checked_at ? ` 行数刷新于 ${new Date(capacity.row_counts_checked_at).toLocaleString('zh-CN')}。` : ''}
                {derived.cappedRowCounts && capacity?.row_counts_limit ? ` 单表计数达到 ${formatInteger(capacity.row_counts_limit)} 后停止，显示为下限。` : ''}
              </Text>
            </Box>
          </section>
        </div>
      </SettingCard>
      <Dialog.Root open={explainDialog !== null} onOpenChange={(open) => !open && setExplainDialog(null)}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>{explainDialog === 'cleanup' ? '维护清理说明' : '刷新实际行数说明'}</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            {explainDialog === 'cleanup'
              ? '维护清理会按当前保留时间删除过期历史记录和过期审计日志，不影响实时展示、节点配置或当前有效记录。'
              : '刷新实际行数会临时查询各历史表当前行数，用于更新页面里的容量参考；不会删除或修改任何数据。'}
          </Dialog.Description>
          <Flex justify="end" gap="2">
            <Button variant="soft" color="gray" onClick={() => setExplainDialog(null)}>取消</Button>
            <Button
              color={explainDialog === 'cleanup' ? 'red' : undefined}
              onClick={() => {
                const action = explainDialog;
                setExplainDialog(null);
                if (action === 'cleanup') void handleMaintenanceCleanup();
                if (action === 'refresh') void handleRefreshActualRows();
              }}
            >
              {explainDialog === 'cleanup' ? '确认清理' : '确认刷新'}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
