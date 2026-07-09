import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Card, Flex, IconButton, Separator, Text, Tooltip } from '@radix-ui/themes';
import { Activity, ArrowDown, ArrowUp, BarChart3, TrendingUp } from 'lucide-react';
import Flag from './Flag';
import PriceTags from './PriceTags';
import MiniPingChartFloat from './MiniPingChartFloat';
import { formatBytes, formatUptime } from '../utils/format';
import { formatTrafficLimitLabel, parseTrafficLimitType } from '../utils/traffic';
import { ClientInfo, LiveRecord } from '../types';
import { getOSDisplay } from '../utils/osIcon';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatCpuCardLabel, formatCpuSpec } from '../utils/cpuFormat';
import { parseMonitorTags } from '../utils/tags';
import { getExpiryInfo } from '../utils/billing';

interface NodeCardProps {
  client: ClientInfo;
  live?: LiveRecord;
  online: boolean;
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
  percent?: number;
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

function formatPercent(value: number) {
  const clamped = clampPercent(value);
  return `${clamped.toFixed(clamped < 10 ? 1 : 0)}%`;
}

function RingMetric({
  label,
  percent,
}: {
  label: string;
  percent: number;
}) {
  const clamped = clampPercent(percent);
  const ringStyle = {
    '--metric-percent': `${clamped}%`,
  } as React.CSSProperties;

  return (
    <div
      className="node-resource-ring"
      data-monitor-role="resource-ring"
      data-load={getUsageLevel(clamped)}
    >
      <div className="node-resource-ring-chart" style={ringStyle}>
        <Text className="node-resource-ring-value" weight="bold">
          {formatPercent(clamped)}
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
}: {
  uploadSpeed: string;
  downloadSpeed: string;
  totalUp: number;
  totalDown: number;
  uptimeLabel: string;
}) {
  return (
    <div className="node-network-panel" data-monitor-role="network-panel">
      <div className="node-network-summary-row" data-monitor-role="network-speed-summary">
        <Text className="node-network-summary-label" size="1" weight="bold">
          <Activity size={14} />
          网络速率
        </Text>
        <div className="node-network-summary-values">
          <span className="node-network-value is-up">
            <ArrowUp size={13} />
            <span className="node-network-direction">上</span>
            <strong>{uploadSpeed}/s</strong>
          </span>
          <span className="node-network-value is-down">
            <ArrowDown size={13} />
            <span className="node-network-direction">下</span>
            <strong>{downloadSpeed}/s</strong>
          </span>
        </div>
      </div>

      <div className="node-network-summary-row" data-monitor-role="network-traffic-summary">
        <Text className="node-network-summary-label" size="1" weight="bold">
          <BarChart3 size={14} />
          总流量
        </Text>
        <div className="node-network-summary-values">
          <span className="node-network-value is-up">
            <ArrowUp size={13} />
            <span className="node-network-direction">上</span>
            <strong>{formatBytes(totalUp)}</strong>
          </span>
          <span className="node-network-value is-down">
            <ArrowDown size={13} />
            <span className="node-network-direction">下</span>
            <strong>{formatBytes(totalDown)}</strong>
          </span>
        </div>
      </div>

      <div className="node-network-summary-row node-network-uptime-row" data-monitor-role="network-uptime-summary">
        <Text className="node-network-summary-label" size="1" weight="bold">
          <Activity size={14} />
          在线时长
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

export default function NodeCard({ client, live, online, includeHidden = false }: NodeCardProps) {
  const isMobile = useIsMobile();
  const defaultLive: LiveRecord = {
    cpu: 0,
    ram: 0,
    ram_total: 0,
    swap: 0,
    swap_total: 0,
    disk: 0,
    disk_total: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    load: 0,
    temp: 0,
    uptime: 0,
    process_count: 0,
    connections: 0,
    connections_udp: 0,
  };
  const d = live || defaultLive;
  const cpuPct = d.cpu || 0;
  const memTotal = client.mem_total || d.ram_total || 0;
  const memPct = memTotal > 0 ? (d.ram / memTotal) * 100 : 0;
  const diskTotal = client.disk_total || d.disk_total || 0;
  const diskPct = diskTotal > 0 ? (d.disk / diskTotal) * 100 : 0;
  const totalUp = d.net_total_up || 0;
  const totalDown = d.net_total_down || 0;
  const uploadSpeed = formatBytes(d.net_out || 0);
  const downloadSpeed = formatBytes(d.net_in || 0);
  const osConfig = getOSDisplay(client.os || '');
  const trafficLimitLabel = formatTrafficLimitLabel(client.traffic_limit, client.traffic_limit_type);
  const uptimeLabel = online && d.uptime > 0 ? formatUptime(d.uptime) : '-';
  const uptimeFooterLabel = online ? uptimeLabel : '当前离线';
  const memDetail = `${formatBytes(d.ram)} / ${formatBytes(memTotal)}`;
  const diskDetail = `${formatBytes(d.disk)} / ${formatBytes(diskTotal)}`;
  const cpuDetail = formatCpuCardLabel(client.cpu_name, client.cpu_cores);
  const cpuTitle = formatCpuSpec(client.cpu_name, client.cpu_cores);

  const trafficUsed = (() => {
    if (!client.traffic_limit || client.traffic_limit <= 0) return 0;
    const type = parseTrafficLimitType(client.traffic_limit_type);
    switch (type) {
      case 'max': return Math.max(totalUp, totalDown);
      case 'min': return Math.min(totalUp, totalDown);
      case 'up': return totalUp;
      case 'down': return totalDown;
      case 'sum':
      default: return totalUp + totalDown;
    }
  })();
  const trafficPct = client.traffic_limit > 0 ? Math.min(100, (trafficUsed / client.traffic_limit) * 100) : undefined;
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
                rangeHours={1}
                includeHidden={includeHidden}
                trigger={
                  <IconButton className="node-card-action" data-node-card-action="true" variant="ghost" size="2" aria-label="查看 Ping 延迟" title="查看 Ping 延迟走势">
                    <TrendingUp size={16} />
                  </IconButton>
                }
              />
              <Badge color={online ? 'green' : 'red'} variant="solid" radius="full">
                {online ? '在线' : '离线'}
              </Badge>
            </Flex>
          </Flex>
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

            <div className="node-card-next-layout" data-monitor-layout="next">
              <div className="node-metric-grid">
                <CompactMetric label="CPU" value={formatPercent(cpuPct)} detail={cpuDetail} title={cpuTitle} percent={cpuPct} />
                <CompactMetric label="内存" value={formatPercent(memPct)} detail={memDetail} percent={memPct} />
                <CompactMetric label="磁盘" value={formatPercent(diskPct)} detail={diskDetail} percent={diskPct} />
                <CompactMetric
                  label="月度"
                  value={trafficLimitLabel ? `${trafficPct?.toFixed(0) || 0}%` : '-'}
                  detail={trafficLimitLabel || '未设置'}
                  percent={trafficLimitLabel ? trafficPct : undefined}
                />
              </div>
              <NetworkSummary
                uploadSpeed={uploadSpeed}
                downloadSpeed={downloadSpeed}
                totalUp={totalUp}
                totalDown={totalDown}
                uptimeLabel={uptimeFooterLabel}
              />
            </div>

            <div className="node-card-monitor-layout" data-monitor-layout="monitor">
              <div className="node-resource-ring-grid">
                <RingMetric label="CPU" percent={cpuPct} />
                <RingMetric label="RAM" percent={memPct} />
                <RingMetric label="Disk" percent={diskPct} />
              </div>

              <NetworkSummary
                uploadSpeed={uploadSpeed}
                downloadSpeed={downloadSpeed}
                totalUp={totalUp}
                totalDown={totalDown}
                uptimeLabel={uptimeFooterLabel}
              />
            </div>
          </Flex>
        </Flex>
      </Link>
    </Card>
  );
}
