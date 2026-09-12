import type { MonitorReportPayload } from './monitor-report';

const METRIC_FIELDS = [
  'cpu', 'gpu', 'ram', 'ram_total', 'swap', 'swap_total', 'load', 'temp',
  'disk', 'disk_total', 'disk_source', 'disk_sampled_at', 'net_in', 'net_out', 'net_total_up', 'net_total_down',
  'process_count', 'connections', 'connections_udp', 'uptime', 'version', 'timestamp',
] as const;
const BASIC_FIELDS = [
  'cpu_name', 'virtualization', 'arch', 'cpu_cores', 'os', 'kernel_version',
  'gpu_name', 'mem_total', 'swap_total', 'disk_total', 'version', 'region',
] as const;
const GPU_FIELDS = ['device_index', 'device_name', 'mem_total', 'mem_used', 'utilization', 'temperature'] as const;

function selectScalars(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const item = record[field];
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      result[field] = item;
    } else if (typeof item === 'string') {
      result[field] = item.slice(0, 256);
    }
  }
  return result;
}

// Internal reports contain connection addresses and optional Agent extensions.
// Public output is a separate allowlisted representation, including nested data.
export function toPublicReport(report: MonitorReportPayload): Record<string, unknown> {
  const result = selectScalars(report, METRIC_FIELDS);
  result.gpus = Array.isArray(report.gpus)
    ? report.gpus.slice(0, 16).map(gpu => selectScalars(gpu, GPU_FIELDS))
    : [];
  if (report.basic_info && typeof report.basic_info === 'object') {
    result.basic_info = selectScalars(report.basic_info, BASIC_FIELDS);
  }
  return result;
}
