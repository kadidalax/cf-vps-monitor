import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Card, Flex, IconButton, Separator, Text, Tooltip } from '@radix-ui/themes';
import { Activity, ArrowDown, ArrowUp, BarChart3, TrendingUp } from 'lucide-react';
import Flag from './Flag';
import PriceTags from './PriceTags';
import MiniPingChartFloat from './MiniPingChartFloat';
import { diskUsagePresentation, formatLastReport, formatMetricBytes, formatMetricSpeed, formatMetricUptime, metricNumber, resourceUsage, type NodeStatus } from '../utils/nodeMetrics';
import { formatTrafficLimitLabel, parseTrafficLimitType } from '../utils/traffic';
import { ClientInfo, LiveRecord } from '../types';
import { getOSDisplay } from '../utils/osIcon';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatCpuCardLabel, formatCpuSpec } from '../utils/cpuFormat';
import { parseMonitorTags } from '../utils/tags';
import { getExpiryInfo } from '../utils/billing';

interface NodeCardProps {
  client: ClientInfo;
  live?: Partial<LiveRecord>;
  online: boolean;
  status?: NodeStatus;
  lastReportTime?: number;
  includeHidden?: boolean;
}

function NodeRegionTagsLine({ region, tags }: { region?: string; tags?: string }) {
  const tagTexts = parseMonitorTags(tags).map((tag) => tag.text);
  const regionLabel = region || '未知';
  const tooltipContent = (
    <span className="node-card-tag-tooltip-content">
      <span className="node-card-tag-tooltip-region">{regionLabel}</span>
      <span className="node-card-tag-tooltip-tags">
        {tagTexts.map((tag, index) => (
          <span className="node-card-tag-tooltip-pill" key={`${tag}-${index}`}>{tag}</span>
        ))}
      </span>
    </span>
  );
  const line = (
    <div className="node-card-region-line node-card-region-tags-line">
      <span className="node-card-region-text">{regionLabel}</span>
      {tagTexts.length > 0 && (
        <span className="node-card-header-tags" aria-label={`标签 ${tagTexts.join(' ')}`}>
          {tagTexts.map((tag, index) => (
            <span className="node-card-header-tag" key={`${tag}-${index}`}>{tag}</span>
          ))}
        </span>
      )}
    </div>
  );

  return tagTexts.length > 0 ? (
    <Tooltip className="node-card-tag-tooltip" content={tooltipContent} side="bottom">
      {line}
    </Tooltip>
  ) : line;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function CompactMetric({
  label,
  value,
  detail,
  percent,
  title,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number | null;
  title?: string;
}) {
  return (
    <div className="node-metric-tile" data-load={typeof percent === 'number' ? (percent >= 85 ? 'hot' : percent >= 65 ? 'warm' : 'normal') : undefined}>
      <Flex justify="between" align="baseline" gap="2">
        <Text className="node-metric-label" size="1">{label}</Text>
        <Text className="node-metric-value" size="2" weight="bold">{value}</Text>
      </Flex>
      <Text className="node-metric-detail" size="1" title={title || detail}>{detail}</Text>
      {typeof percent === 'number' && (
        <span className="node-metric-bar" aria-hidden="true">
          <span style={{ transform: `scaleX(${clampPercent(percent) / 100})` }} />
        </span>
      )}
    </div>
  );
}

function getUsageLevel(percent: number) {
  if (percent >= 85) return 'hot';
  if (percent >= 65) return 'warm';
  return 'normal';
}

function formatPercent(value: number | null) {
  if (value === null) return '—';
  const clamped = clampPercent(value);
  return `${clamped.toFixed(clamped < 10 ? 1 : 0)}%`;
}

function RingMetric({
  label,
  percent,
  estimated = false,
  title,
}: {
  label: string;
  percent: number | null;
  estimated?: boolean;
  title?: string;
}) {
  const clamped = clampPercent(percent ?? 0);
  const ringStyle = {
    '--metric-percent': `${clamped}%`,
  } as React.CSSProperties;

  return (
    <div
      className="node-resource-ring"
      data-monitor-role="resource-ring"
      data-load={percent === null ? undefined : getUsageLevel(clamped)}
      title={title}
    >
      <div className="node-resource-ring-chart" style={ringStyle}>
        <Text className="node-resource-ring-value" weight="bold">
          {estimated && percent !== null ? '≈ ' : ''}{formatPercent(percent === null ? null : clamped)}
        </Text>
      </div>
      <Text className="node-resource-ring-label" weight="bold">{label}</Text>
    </div>
  );
}

function NetworkSummary({
  uploadSpeed,
  downloadSpeed,
  totalUp,
  totalDown,
  uptimeLabel,
  historical,
}: {
  uploadSpeed: string;
  downloadSpeed: string;
  totalUp: number | null;
  totalDown: number | null;
  uptimeLabel: string;
  historical: boolean;
}) {
  return (
    <div className="node-network-panel" data-monitor-role="network-panel">
      <div className="node-network-summary-row" data-monitor-role="network-speed-summary">
        <Text className="node-network-summary-label" size="1" weight="bold">
          <Activity size={14} />
          {historical ? '上报时网速' : '网速'}
        </Text>
        <div className="node-network-summary-values">
          <span className="node-network-value is-up" aria-label="上传速率">
            <ArrowUp size={13} />
            <strong>{uploadSpeed}</strong>
          </span>
          <span className="node-network-value is-down" aria-label="下载速率">
            <ArrowDown size={13} />
            <strong>{downloadSpeed}</strong>
          </span>
        </div>
      </div>

      <div className="node-network-summary-row" data-monitor-role="network-traffic-summary">
        <Text className="node-network-summary-label" size="1" weight="bold">
          <BarChart3 size={14} />
          流量
        </Text>
        <div className="node-network-summary-values">
          <span className="node-network-value is-up" aria-label="上传总量">
            <ArrowUp size={13} />
            <strong>{formatMetricBytes(totalUp)}</strong>
          </span>
          <span className="node-network-value is-down" aria-label="下载总量">
            <ArrowDown size={13} />
            <strong>{formatMetricBytes(totalDown)}</strong>
          </span>
        </div>
      </div>

      <div className="node-network-summary-row node-network-uptime-row" data-monitor-role="network-uptime-summary">
        <Text className="node-network-summary-label" size="1" weight="bold">
          <Activity size={14} />
          {historical ? '上报时已运行' : '在线时长'}
        </Text>
        <div className="node-network-summary-values node-network-uptime-values">
          <span className="node-network-value node-network-uptime-value">
            <strong className="node-uptime-nowrap" title={uptimeLabel}>{uptimeLabel}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function NodeIpBadges({ client, className }: { client: ClientInfo; className?: string }) {
  const hasIpv4 = Boolean(client.has_ipv4 || client.ipv4);
  const hasIpv6 = Boolean(client.has_ipv6 || client.ipv6);
  if (!hasIpv4 && !hasIpv6) return null;

  return (
    <Flex className={['node-ip-family-badges', className].filter(Boolean).join(' ')} align="center" gap="1" wrap="nowrap">
      {hasIpv4 && <Badge size="1" variant="soft" color="gray">IPv4</Badge>}
      {hasIpv6 && <Badge size="1" variant="soft" color="gray">IPv6</Badge>}
    </Flex>
  );
}

export default function NodeCard({ client, live, online, status, lastReportTime, includeHidden = false }: NodeCardProps) {
  const isMobile = useIsMobile();
  const defaultLive: Partial<LiveRecord> = {
    temp: null,
  };
  const d = live || defaultLive;
  const nodeStatus = status ?? (online ? 'online' : 'offline');
  const cpuPct = metricNumber(d.cpu);
  const memory = resourceUsage(d.ram, d.ram_total, client.mem_total);
  const disk = diskUsagePresentation(d, client.disk_total);
  const memPct = memory.percent;
  const diskPct = disk.percent;
  const totalUp = metricNumber(d.net_total_up);
  const totalDown = metricNumber(d.net_total_down);
  const uploadSpeed = formatMetricSpeed(d.net_out);
  const downloadSpeed = formatMetricSpeed(d.net_in);
  const osConfig = getOSDisplay(client.os || '');
  const trafficLimitLabel = formatTrafficLimitLabel(client.traffic_limit, client.traffic_limit_type);
  const uptimeLabel = formatMetricUptime(d.uptime);
  const memDetail = `${formatMetricBytes(memory.used)} / ${formatMetricBytes(memory.total)}`;
  const diskDetail = disk.detail;
  const cpuDetail = formatCpuCardLabel(client.cpu_name, client.cpu_cores);
  const cpuTitle = formatCpuSpec(client.cpu_name, client.cpu_cores);

  const trafficUsed = (() => {
    if (!client.traffic_limit || client.traffic_limit <= 0) return 0;
    const type = parseTrafficLimitType(client.traffic_limit_type);
    switch (type) {
      case 'max': return totalUp === null || totalDown === null ? null : Math.max(totalUp, totalDown);
      case 'min': return totalUp === null || totalDown === null ? null : Math.min(totalUp, totalDown);
      case 'up': return totalUp;
      case 'down': return totalDown;
      case 'sum':
      default: return totalUp === null || totalDown === null ? null : totalUp + totalDown;
    }
  })();
  const trafficPct = client.traffic_limit > 0 && trafficUsed !== null ? Math.min(100, (trafficUsed / client.traffic_limit) * 100) : undefined;
  const hasBillingInfo = (client.price !== undefined && client.price !== 0) || Boolean(getExpiryInfo(client.expired_at).label);
  const handleCardLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-node-card-action="true"]')) {
      event.preventDefault();
    }
  };

  return (
    <Card
      className="node-card"
      style={{ width: '100%', margin: '0 auto', opacity: online ? 1 : 0.75 }}
      id={client.uuid}
    >
      <Link className="node-card-link" to={`/instance/${client.uuid}`} onClick={handleCardLinkClick} style={{ textDecoration: 'none', color: 'inherit' }}>
        <Flex className="node-card-body" direction="column" gap="2">
          <Flex className="node-card-header" justify="between" align="start" my={isMobile ? '-1' : '0'} data-has-message={d.message ? 'true' : undefined}>
            <Flex justify="start" align="center" style={{ flex: 1, minWidth: 0 }}>
              <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
                <Flex className="node-card-title-row" align="center" gap="2">
                  <span
                    className="node-card-corner-flag"
                    data-monitor-role="node-region-flag"
                    role="img"
                    aria-label={`服务器归属地 ${client.region || '未知'}`}
                  >
                    <Flag region={client.region} size={isMobile ? 18 : 20} />
                  </span>
                  <Text weight="bold" size={isMobile ? '2' : '4'} truncate style={{ maxWidth: '100%' }}>
                    {client.name}
                  </Text>
                </Flex>
                <NodeRegionTagsLine region={client.region} tags={client.tags} />
              </Flex>
            </Flex>

            <Flex className="node-card-status-row" gap="2" align="center" style={{ flex: 'none' }}>
              {d.message && (
                <Box
                  style={{
                    width: 20, height: 20, borderRadius: '50%',
                    background: 'var(--red-9)', color: 'white',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 'bold', cursor: 'help', flexShrink: 0,
                  }}
                  title={d.message}
                >!</Box>
              )}
              <MiniPingChartFloat
                uuid={client.uuid}
                chartWidth={460}
                chartHeight={260}
                limit={360}
                rangeHours={4}
                includeHidden={includeHidden}
                trigger={
                  <IconButton className="node-card-action" data-node-card-action="true" variant="ghost" size="2" aria-label="查看 Ping 延迟" title="查看 Ping 延迟走势">
                    <TrendingUp size={16} />
                  </IconButton>
                }
              />
              <Badge color={nodeStatus === 'online' ? 'green' : nodeStatus === 'offline' ? 'red' : 'gray'} variant="solid" radius="full">
                {nodeStatus === 'online' ? '在线' : nodeStatus === 'offline' ? '离线' : '确认中'}
              </Badge>
            </Flex>
          </Flex>
          {nodeStatus === 'offline' && <Text size="1" color="gray">最后上报 {formatLastReport(lastReportTime)}{!live && ' · 暂无上报数据'}</Text>}
          <Flex className="node-card-title-meta" align="center" gap="2">
            <span className="node-os-chip">
              <img src={osConfig.image} alt="" aria-hidden="true" />
              {osConfig.name}
            </span>
            <span className="node-card-billing-row" aria-hidden={!hasBillingInfo}>
              <PriceTags
                price={client.price}
                billing_cycle={client.billing_cycle}
                currency={client.currency}
                expired_at={client.expired_at}
                showTags={false}
                showExpiry
              />
            </span>
            <NodeIpBadges client={client} className="node-card-title-ip-badges" />
          </Flex>

          <Separator size="4" className="-mt-1" />

          <Flex direction="column" gap="2">
            <div className="node-card-system-line">
              <div className="node-card-system-main">
                <Flex align="center" gap="1" style={{ minWidth: 0 }}>
                  <img src={osConfig.image} alt={osConfig.name} style={{ width: 16, height: 16 }} />
                  <Text size="1" truncate>{osConfig.name}</Text>
                </Flex>
                <span className="node-card-billing-row node-card-system-billing-row" aria-hidden={!hasBillingInfo}>
                  <PriceTags
                    price={client.price}
                    billing_cycle={client.billing_cycle}
                    currency={client.currency}
                    expired_at={client.expired_at}
                    showTags={false}
                    showExpiry
                  />
                </span>
              </div>
              <NodeIpBadges client={client} />
            </div>

            <div className="node-card-tile-layout" data-monitor-layout="tile">
              <div className="node-metric-grid">
                <CompactMetric label="CPU" value={formatPercent(cpuPct)} detail={cpuDetail} title={cpuTitle} percent={cpuPct} />
                <CompactMetric label="内存" value={formatPercent(memPct)} detail={memDetail} percent={memPct} />
                <CompactMetric label={disk.estimated ? '磁盘（估算）' : '磁盘'} value={`${disk.estimated && diskPct !== null ? '≈ ' : ''}${formatPercent(diskPct)}`} detail={diskDetail} title={disk.estimated ? `${disk.description} ${disk.sampleLabel}` : undefined} percent={diskPct} />
                <CompactMetric
                  label="月度"
                  value={trafficLimitLabel ? trafficPct === undefined ? '—' : `${trafficPct.toFixed(0)}%` : '-'}
                  detail={trafficLimitLabel || '未设置'}
                  percent={trafficLimitLabel ? trafficPct : undefined}
                />
              </div>
              <NetworkSummary
                uploadSpeed={uploadSpeed}
                downloadSpeed={downloadSpeed}
                totalUp={totalUp}
                totalDown={totalDown}
                uptimeLabel={uptimeLabel}
                historical={nodeStatus === 'offline'}
              />
            </div>

            <div className="node-card-monitor-layout" data-monitor-layout="monitor">
              <div className="node-resource-ring-grid">
                <RingMetric label="CPU" percent={cpuPct} />
                <RingMetric label="RAM" percent={memPct} />
                <RingMetric label={disk.estimated ? 'Disk（估算）' : 'Disk'} percent={diskPct} estimated={disk.estimated} title={disk.estimated ? `${disk.description} ${disk.detail} ${disk.sampleLabel}` : undefined} />
              </div>

              <NetworkSummary
                uploadSpeed={uploadSpeed}
                downloadSpeed={downloadSpeed}
                totalUp={totalUp}
                totalDown={totalDown}
                uptimeLabel={uptimeLabel}
                historical={nodeStatus === 'offline'}
              />
            </div>
          </Flex>
        </Flex>
      </Link>
    </Card>
  );
}
