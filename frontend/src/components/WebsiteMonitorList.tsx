import { useMemo, useRef } from 'react';
import { Box, Flex, SegmentedControl, Text } from '@radix-ui/themes';
import { ExternalLink } from 'lucide-react';
import WebsiteHeartbeatBar, { WebsiteHeartbeatPoint } from './WebsiteHeartbeatBar';

export type WebsiteMonitorStatus = 'pending' | 'up' | 'down' | 'paused';
const DEFAULT_WEBSITE_INTERVAL_SEC = 120;

export interface WebsiteMonitorSummary {
  id: number;
  name: string;
  url: string;
  interval_sec: number;
  status: WebsiteMonitorStatus;
  last_checked_at: string | null;
  last_status_code: number | null;
  last_raw_status_code?: number | null;
  last_latency_ms: number | null;
  last_effective_reason?: string | null;
  hidden?: boolean;
  checks: WebsiteHeartbeatPoint[];
}

function statusText(status: WebsiteMonitorStatus) {
  if (status === 'up') return '正常';
  if (status === 'down') return '失效';
  if (status === 'paused') return '暂停';
  return '等待';
}

function uptimePercent(checks: WebsiteHeartbeatPoint[]) {
  if (checks.length === 0) return '0%';
  const ok = checks.filter((check) => check.ok).length;
  return `${Math.round((ok / checks.length) * 100)}%`;
}

function lastSeenText(value: string | null) {
  if (!value) return '现在';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '现在';
  if (minutes < 60) return `${minutes}m 之前`;
  return `${Math.floor(minutes / 60)}h 之前`;
}

function statusLine(monitor: WebsiteMonitorSummary) {
  const latency = `${monitor.last_latency_ms ?? 0}ms`;
  if (monitor.url.startsWith('tcp:')) return `${statusText(monitor.status)} · TCP · ${latency}`;
  if (monitor.status === 'down') return `${statusText(monitor.status)} · HTTP ${monitor.last_raw_status_code ?? monitor.last_status_code ?? '-'} · ${latency}`;
  return `${statusText(monitor.status)} · ${latency}`;
}

function checksInPeriod(checks: WebsiteHeartbeatPoint[], hours: number) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return checks.filter((check) => new Date(check.checked_at).getTime() >= cutoff);
}

function heartbeatSegmentCount(periodHours: number, intervalSec = DEFAULT_WEBSITE_INTERVAL_SEC) {
  const interval = Math.max(1, Number(intervalSec) || DEFAULT_WEBSITE_INTERVAL_SEC);
  if (periodHours === 1) return Math.max(1, Math.ceil(periodHours * 60 * 60 / interval));
  return 72;
}

function bucketChecksByPeriod(checks: WebsiteHeartbeatPoint[], periodHours: number, segmentCount: number) {
  const end = Date.now();
  const periodMs = periodHours * 60 * 60 * 1000;
  const start = end - periodMs;
  const bucketMs = periodHours * 60 * 60 * 1000 / segmentCount;
  const buckets: Array<WebsiteHeartbeatPoint | null> = Array.from({ length: segmentCount }, () => null);

  for (const check of checks) {
    const time = new Date(check.checked_at).getTime();
    if (time < start || time > end) continue;
    const index = Math.min(segmentCount - 1, Math.floor((time - start) / bucketMs));
    const current = buckets[index];
    if (!current || time > new Date(current.checked_at).getTime()) buckets[index] = check;
  }

  return buckets.reverse();
}

export default function WebsiteMonitorList({
  monitors,
  loading,
  periodHours,
  onPeriodChange,
  periods = [1, 24, 72],
}: {
  monitors: WebsiteMonitorSummary[];
  loading?: boolean;
  periodHours: number;
  onPeriodChange: (hours: number) => void;
  periods?: readonly number[];
}) {
  // ponytail: 切换周期时 checks 数据异步到达，用新周期对旧数据分桶会产生大量空桶闪灰。
  // loading 期间保持上一个已渲染周期，数据就绪后一并切换。
  const lastPeriodRef = useRef(periodHours);
  if (!loading) {
    lastPeriodRef.current = periodHours;
  }
  const renderPeriodHours = loading ? lastPeriodRef.current : periodHours;

  const summary = useMemo(() => {
    const up = monitors.filter((monitor) => monitor.status === 'up').length;
    const down = monitors.filter((monitor) => monitor.status === 'down').length;
    return { up, down, total: monitors.length };
  }, [monitors]);

  return (
    <section className="kuma-monitor-list">
      <div className="kuma-monitor-summary">
        <Box className="kuma-monitor-title-line">
          <Text size="4" weight="bold">网站监控</Text>
          <Text size="2" color="gray">
            {summary.total === 0 ? (loading ? '加载中' : '暂无网站') : `${summary.up} 正常 / ${summary.down} 失效 / ${summary.total} 总数`}
          </Text>
        </Box>
        <SegmentedControl.Root
          size="1"
          value={String(periodHours)}
          onValueChange={(value) => onPeriodChange(Number(value))}
        >
          {periods.map((hours) => (
            <SegmentedControl.Item key={hours} value={String(hours)}>
              {hours}小时
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
      </div>
      <div className="kuma-monitor-items">
        {monitors.map((monitor) => {
          const periodChecks = checksInPeriod(monitor.checks || [], renderPeriodHours);
          const segmentCount = heartbeatSegmentCount(renderPeriodHours, monitor.interval_sec);
          const bucketedChecks = bucketChecksByPeriod(monitor.checks || [], renderPeriodHours, segmentCount);
          return (
          <article
            key={monitor.id}
            className={`kuma-monitor-row is-${monitor.status}`}
          >
            <span className={`kuma-monitor-uptime-pill is-${monitor.status}`}>{uptimePercent(periodChecks)}</span>
            <Box className="kuma-monitor-row-main">
              <Flex align="center" gap="2" className="kuma-monitor-url-line">
                <a
                  href={monitor.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {monitor.name}
                </a>
                <ExternalLink size={12} aria-hidden="true" />
              </Flex>
              <Text size="1" color={monitor.status === 'up' ? 'green' : monitor.status === 'down' ? 'red' : 'gray'}>
                {statusLine(monitor)}
              </Text>
            </Box>
            <Box className="kuma-monitor-row-heartbeat">
              <WebsiteHeartbeatBar checks={bucketedChecks} max={segmentCount} />
              <Flex justify="between" className="kuma-monitor-row-time">
                <Text size="1" color="gray">{renderPeriodHours}h</Text>
                <Text size="1" color="gray">{lastSeenText(monitor.last_checked_at)}</Text>
              </Flex>
            </Box>
          </article>
        )})}
        {monitors.length === 0 && !loading && (
          <div className="kuma-monitor-empty">暂无网站监控</div>
        )}
      </div>
    </section>
  );
}
