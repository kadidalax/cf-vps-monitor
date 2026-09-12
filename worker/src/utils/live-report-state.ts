import { normalizeMonitorReport, type MonitorReportPayload } from './monitor-report';
import { toPublicReport } from './public-report';
import { isPublicIpAddress } from './request-ip';

// Persist the fields needed to reconstruct live metrics, not probe queues or
// arbitrary Agent extensions. Basic metadata is synchronized separately.
export function compactLiveReport(report: MonitorReportPayload): MonitorReportPayload {
  const compact = normalizeMonitorReport(toPublicReport(report));
  for (const field of ['ipv4', 'ipv6'] as const) {
    if (typeof report[field] === 'string' && isPublicIpAddress(report[field])) compact[field] = report[field];
  }
  if (typeof report.region === 'string') compact.region = report.region.slice(0, 256);
  return compact;
}

export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
