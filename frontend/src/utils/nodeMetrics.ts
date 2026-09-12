import type { LiveDataMap, LiveRecord } from '../types';
import { formatBytes, formatSpeed, formatUptime } from './format';
import { diskMeasurementMetadata } from './diskMeasurement';

export type NodeStatus = 'online' | 'offline' | 'unknown';

export function metricNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function resourceTotal(reported: unknown, metadata?: number): number | null {
  const value = metricNumber(reported === undefined ? metadata : reported);
  return value !== null && value > 0 ? value : null;
}

export function resourceUsage(usedValue: unknown, reportedTotal: unknown, metadataTotal?: number) {
  const used = metricNumber(usedValue);
  const total = resourceTotal(reportedTotal, metadataTotal);
  return { used, total, percent: used !== null && total !== null ? Math.min(100, used / total * 100) : null };
}

export function diskUsagePresentation(record: Partial<LiveRecord> = {}, metadataTotal?: number) {
  const source = diskMeasurementMetadata(record);
  const usage = resourceUsage(source.attempted && !source.valid ? null : record.disk, record.disk_total, metadataTotal);
  const estimated = source.valid;
  const sampleLabel = estimated ? `采样 ${formatLastReport(source.sampledAt)}` : '';
  const description = estimated
    ? '文件占用估算；不含快照、被挂载遮挡及已删除但仍打开的文件。'
    : '';
  return {
    ...usage, estimated, sampledAt: source.sampledAt, sampleLabel, description,
    detail: `${estimated ? '≈ ' : ''}${formatMetricBytes(usage.used)} / ${formatMetricBytes(usage.total)}`,
  };
}

export function getNodeStatus(uuid: string, live: LiveDataMap): NodeStatus {
  if (live.online.includes(uuid)) return 'online';
  return live.statusReady === false ? 'unknown' : 'offline';
}

export function getNodeDisplayRecord(uuid: string, live: LiveDataMap): Partial<LiveRecord> | undefined {
  return live.online.includes(uuid) ? live.data[uuid] : live.last_known?.[uuid];
}

export function getNodeLastReportTime(uuid: string, live: LiveDataMap): number | undefined {
  if (!live.online.includes(uuid)) return live.last_known?.[uuid]?.lastReportTime;
  return live.clients?.find(client => client.uuid === uuid)?.lastReportTime ?? live.data[uuid]?.lastReportTime;
}

export function formatMetricBytes(value: unknown): string {
  const metric = metricNumber(value);
  return metric === null ? '—' : formatBytes(metric);
}

export function formatMetricSpeed(value: unknown): string {
  const metric = metricNumber(value);
  return metric === null ? '—' : formatSpeed(metric);
}

export function formatMetricUptime(value: unknown): string {
  const metric = metricNumber(value);
  return metric === null ? '—' : formatUptime(metric);
}

export function formatLastReport(timestamp?: number): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
