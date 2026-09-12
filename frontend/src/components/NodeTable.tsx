/**
 * NodeTable - sortable public node table with expandable details.
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Flex, IconButton, Popover, Table, Text } from '@radix-ui/themes';
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown } from 'lucide-react';
import UsageBar from './UsageBar';
import Flag from './Flag';
import MiniPingChart from './MiniPingChart';
import PriceTags from './PriceTags';
import { diskUsagePresentation, formatMetricBytes, formatMetricSpeed, formatMetricUptime, formatLastReport, getNodeDisplayRecord, getNodeLastReportTime, getNodeStatus, metricNumber, resourceTotal, resourceUsage, type NodeStatus } from '../utils/nodeMetrics';
import { comparePublicClients } from '../utils/publicClients';
import { getOSImage, getOSName } from '../utils/osIcon';
import { ClientInfo, LiveDataMap, LiveRecord } from '../types';
import { formatCpuSpec } from '../utils/cpuFormat';

interface NodeTableProps {
  nodes: ClientInfo[];
  liveData: LiveDataMap;
  includeHidden?: boolean;
}

type SortKey = 'manual' | 'name' | 'os' | 'status' | 'cpu' | 'ram' | 'disk' | 'network' | 'price' | 'traffic';
type SortDir = 'asc' | 'desc';

function formatUptimeZh(seconds?: number | null): string {
  if (metricNumber(seconds) === null) return '—';
  seconds = seconds as number;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 时`);
  if (m) parts.push(`${m} 分`);
  if (s || parts.length === 0) parts.push(`${s} 秒`);
  return parts.join(' ');
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="node-table-detail-row">
      <Text size="1" color="gray" className="node-table-detail-label">
        {label}
      </Text>
      <Text size="2" weight="medium" className="node-table-detail-value">
        {value || '-'}
      </Text>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="node-table-detail-section">
      <Text size="2" weight="bold" className="node-table-detail-section-title">
        {title}
      </Text>
      <div className="node-table-detail-section-body">
        {children}
      </div>
    </section>
  );
}

function RemarkDetailRow({ value }: { value?: string }) {
  const text = value?.trim();

  if (!text) {
    return <DetailRow label="备注" value="-" />;
  }

  return (
    <div className="node-table-detail-row node-table-remark-row">
      <Text size="1" color="gray" className="node-table-detail-label">
        备注
      </Text>
      <Popover.Root>
        <Popover.Trigger>
          <button type="button" className="node-table-remark-trigger" title={text}>
            <Text size="2" weight="medium" className="node-table-remark-preview" as="span">
              {text}
            </Text>
          </button>
        </Popover.Trigger>
        <Popover.Content side="right" align="start" className="node-table-remark-popover">
          <Text size="1" weight="bold" className="node-table-detail-label">
            备注
          </Text>
          <div className="node-table-remark-popover-body">
            {text}
          </div>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

function formatSupport(supported?: boolean, sourceValue?: string) {
  return supported || Boolean(sourceValue) ? '支持' : '不支持';
}

function ExpandedNodeDetails({
  node,
  live,
  lastReportTime,
  status,
  includeHidden = false,
}: {
  node: ClientInfo;
  live?: Partial<LiveRecord>;
  lastReportTime?: number;
  status: NodeStatus;
  includeHidden?: boolean;
}) {
  return (
    <Box className="node-table-expanded">
      <Flex gap="3" wrap="wrap" align="center" className="node-table-tags">
        <PriceTags
          price={node.price}
          billing_cycle={node.billing_cycle}
          expired_at={node.expired_at}
          currency={node.currency}
          showTags={false}
        />
      </Flex>

      <div className="node-table-expanded-layout">
        <div className="node-table-detail-sections">
          <DetailSection title="资源规格">
            <DetailRow label="CPU" value={formatCpuSpec(node.cpu_name, node.cpu_cores)} />
            <DetailRow label="内存" value={formatMetricBytes(resourceTotal(live?.ram_total, node.mem_total))} />
            <DetailRow label="交换" value={formatMetricBytes(live?.swap_total ?? node.swap_total)} />
            <DetailRow label="磁盘" value={diskUsagePresentation(live, node.disk_total).detail} />
            {diskUsagePresentation(live).estimated && <DetailRow label="文件占用估算" value={diskUsagePresentation(live).sampleLabel} />}
          </DetailSection>

          <DetailSection title="系统环境">
            <DetailRow label="架构" value={node.arch || '-'} />
            <DetailRow label="虚拟化" value={node.virtualization || '-'} />
            <DetailRow label="GPU" value={node.gpu_name || '-'} />
            <DetailRow
              label="操作系统"
              value={
                <span>
                  {node.os || '-'}
                </span>
              }
            />
          </DetailSection>

          <DetailSection title="网络与流量">
            <DetailRow
              label={status === 'offline' ? '上报时网速' : '当前速率'}
              value={`↑ ${formatMetricSpeed(live?.net_out)} ↓ ${formatMetricSpeed(live?.net_in)}`}
            />
            <DetailRow
              label="流量"
              value={`↑ ${formatMetricBytes(live?.net_total_up)} ↓ ${formatMetricBytes(live?.net_total_down)}`}
            />
            <DetailRow label="IPv4" value={formatSupport(node.has_ipv4, node.ipv4)} />
            <DetailRow label="IPv6" value={formatSupport(node.has_ipv6, node.ipv6)} />
          </DetailSection>

          <DetailSection title="运行状态">
            <DetailRow label={status === 'offline' ? '上报时已运行' : '运行时间'} value={formatUptimeZh(live?.uptime)} />
            <DetailRow label="最后上报" value={formatLastReport(lastReportTime)} />
            <DetailRow label="地区" value={node.region || '-'} />
            <RemarkDetailRow value={node.public_remark} />
          </DetailSection>
        </div>

        <div className="node-table-ping-section">
          <MiniPingChart uuid={node.uuid} width="100%" height={210} limit={180} fillContainer includeHidden={includeHidden} />
        </div>
      </div>
    </Box>
  );
}

function SortHeader({ column, children, style, activeKey, direction, onSort }: {
  column: SortKey;
  children: React.ReactNode;
  style?: React.CSSProperties;
  activeKey: SortKey;
  direction: SortDir;
  onSort: (column: SortKey) => void;
}) {
  return (
    <Table.ColumnHeaderCell style={{ whiteSpace: 'nowrap', ...style }} aria-sort={activeKey === column ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="node-table-sort-button" onClick={() => onSort(column)}>
        {children}
        {activeKey !== column ? <ChevronsUpDown size={12} style={{ opacity: 0.35 }} aria-hidden="true" /> : direction === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}
      </button>
    </Table.ColumnHeaderCell>
  );
}

export default function NodeTable({ nodes, liveData, includeHidden = false }: NodeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('manual');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const onlineSet = useMemo(() => new Set(liveData?.online || []), [liveData?.online]);
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortKey(key);
    setSortDir('asc');
  };

  const sortHeaderProps = { activeKey: sortKey, direction: sortDir, onSort: handleSort };

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      const aOnline = onlineSet.has(a.uuid);
      const bOnline = onlineSet.has(b.uuid);
      if (liveData.statusReady !== false && aOnline !== bOnline) return aOnline ? -1 : 1;
      const aLive = getNodeDisplayRecord(a.uuid, liveData);
      const bLive = getNodeDisplayRecord(b.uuid, liveData);

      let cmp = 0;
      let metrics: [unknown, unknown] | undefined;
      switch (sortKey) {
        case 'manual':
          cmp = comparePublicClients(a, b);
          break;
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
        case 'os':
          cmp = (a.os || '').localeCompare(b.os || '');
          break;
        case 'status':
          cmp = 0;
          break;
        case 'cpu':
          metrics = [aLive?.cpu, bLive?.cpu];
          break;
        case 'ram':
          metrics = [resourceUsage(aLive?.ram, aLive?.ram_total, a.mem_total).percent, resourceUsage(bLive?.ram, bLive?.ram_total, b.mem_total).percent];
          break;
        case 'disk':
          metrics = [resourceUsage(aLive?.disk, aLive?.disk_total, a.disk_total).percent, resourceUsage(bLive?.disk, bLive?.disk_total, b.disk_total).percent];
          break;
        case 'network':
          cmp = ((aLive?.net_in || 0) + (aLive?.net_out || 0)) - ((bLive?.net_in || 0) + (bLive?.net_out || 0));
          break;
        case 'price':
          cmp = (a.price || 0) - (b.price || 0);
          break;
        case 'traffic':
          cmp = ((aLive?.net_total_up || 0) + (aLive?.net_total_down || 0)) - ((bLive?.net_total_up || 0) + (bLive?.net_total_down || 0));
          break;
      }

      if (metrics) {
        const [aValue, bValue] = metrics.map(metricNumber);
        if (aValue === null || bValue === null) {
          if (aValue !== bValue) return aValue === null ? 1 : -1;
        } else cmp = aValue - bValue;
      }
      return (sortDir === 'asc' ? cmp : -cmp) || comparePublicClients(a, b);
    });
  }, [nodes, sortKey, sortDir, liveData, onlineSet]);

  const toggleExpanded = (uuid: string) => {
    setExpandedRows((current) =>
      current.includes(uuid)
        ? current.filter((item) => item !== uuid)
        : [...current, uuid],
    );
  };

  return (
    <Box className="node-table-scroll">
      <Table.Root
        className="node-table-root"
        variant="surface"
        size="1"
        style={{ width: '100%', minWidth: 1254, tableLayout: 'fixed' }}
      >
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell style={{ width: 36 }} />
            <SortHeader {...sortHeaderProps} column="name" style={{ width: 180 }}>名称</SortHeader>
            <SortHeader {...sortHeaderProps} column="os" style={{ width: 132 }}>系统</SortHeader>
            <SortHeader {...sortHeaderProps} column="status" style={{ width: 136 }}>状态</SortHeader>
            <SortHeader {...sortHeaderProps} column="cpu" style={{ width: 118 }}>CPU</SortHeader>
            <SortHeader {...sortHeaderProps} column="ram" style={{ width: 118 }}>内存</SortHeader>
            <SortHeader {...sortHeaderProps} column="disk" style={{ width: 118 }}>硬盘</SortHeader>
            <SortHeader {...sortHeaderProps} column="network" style={{ width: 142 }}>网络</SortHeader>
            <SortHeader {...sortHeaderProps} column="price" style={{ width: 108 }}>价格</SortHeader>
            <SortHeader {...sortHeaderProps} column="traffic" style={{ width: 166 }}>流量</SortHeader>
          </Table.Row>
        </Table.Header>

        <Table.Body>
          {sortedNodes.map((node) => {
            const isOnline = onlineSet.has(node.uuid);
            const status = getNodeStatus(node.uuid, liveData);
            const live = getNodeDisplayRecord(node.uuid, liveData);
            const cpuVal = metricNumber(live?.cpu);
            const ramPct = resourceUsage(live?.ram, live?.ram_total, node.mem_total).percent;
            const disk = diskUsagePresentation(live, node.disk_total);
            const diskPct = disk.percent;
            const isExpanded = expandedRows.includes(node.uuid);
            const uptimeLabel = formatMetricUptime(live?.uptime);

            return (
              <React.Fragment key={node.uuid}>
                <Table.Row style={{ cursor: 'pointer' }} onClick={() => toggleExpanded(node.uuid)}>
                  <Table.Cell>
                    <IconButton
                      variant="ghost"
                      size="1"
                      aria-label={isExpanded ? '收起详情' : '展开详情'}
                    >
                      <ChevronRight
                        size={14}
                        style={{
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.15s ease',
                        }}
                      />
                    </IconButton>
                  </Table.Cell>
                  <Table.Cell>
                    <Link
                      to={`/instance/${node.uuid}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                      onClick={(event: React.MouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
                    >
                      <Flex className="node-table-name-cell" align="center" gap="2">
                        <Flag region={node.region} size={16} />
                        <Box style={{ minWidth: 0 }}>
                          <Text weight="bold" size="2" truncate>{node.name}</Text>
                          {node.group && <Text size="1" color="gray" truncate>{node.group}</Text>}
                        </Box>
                      </Flex>
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                      <img src={getOSImage(node.os)} alt="" style={{ width: 18, height: 18 }} />
                      <Text size="2" truncate style={{ maxWidth: 82 }}>{getOSName(node.os)}</Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell className="node-table-status-cell">
                    <Flex className="node-table-status-stack" gap="1" align="center">
                      <Badge color={status === 'online' ? 'green' : status === 'offline' ? 'red' : 'gray'} variant="soft" size="1">
                        {status === 'online' ? '在线' : status === 'offline' ? '离线' : '确认中'}
                      </Badge>
                      {isOnline && (
                        <Text size="1" color="gray" className="node-uptime-nowrap" title={uptimeLabel}>
                          {uptimeLabel}
                        </Text>
                      )}
                      {status === 'offline' && <Text size="1" color="gray" title="以下指标为最后一次上报状态">最后上报 {formatLastReport(getNodeLastReportTime(node.uuid, liveData))}</Text>}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Box className="node-table-resource-cell">
                      {cpuVal !== null && <UsageBar value={cpuVal} showLabel={false} />}
                      <Text size="1" color="gray">{cpuVal === null ? '—' : `${cpuVal.toFixed(1)}%`}</Text>
                    </Box>
                  </Table.Cell>
                  <Table.Cell>
                    <Box className="node-table-resource-cell">
                      {ramPct !== null && <UsageBar value={ramPct} showLabel={false} />}
                      <Text size="1" color="gray">{ramPct === null ? '—' : `${ramPct.toFixed(1)}%`}</Text>
                    </Box>
                  </Table.Cell>
                  <Table.Cell>
                    <Box className="node-table-resource-cell">
                      {diskPct !== null && <UsageBar value={diskPct} showLabel={false} />}
                      <Text size="1" color="gray" title={disk.estimated ? `${disk.detail}；${disk.description} ${disk.sampleLabel}` : diskPct === null ? '磁盘使用量或容量未提供' : undefined}>{diskPct === null ? '—' : `${disk.estimated ? '≈ ' : ''}${diskPct.toFixed(1)}%`}</Text>
                    </Box>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="2" style={{ whiteSpace: 'nowrap' }}>
                      ↑ {formatMetricSpeed(live?.net_out)} ↓ {formatMetricSpeed(live?.net_in)}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    {node.price !== undefined && node.price !== 0 ? (
                      <PriceTags
                        price={node.price}
                        billing_cycle={node.billing_cycle}
                        currency={node.currency}
                        showTags={false}
                        showExpiry={false}
                      />
                    ) : (
                      <Text size="2" color="gray">-</Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="2" style={{ whiteSpace: 'nowrap' }}>
                      ↑ {formatMetricBytes(live?.net_total_up)} ↓ {formatMetricBytes(live?.net_total_down)}
                    </Text>
                  </Table.Cell>
                </Table.Row>

                {isExpanded && (
                  <Table.Row>
                    <Table.Cell colSpan={10} className="node-table-expanded-cell">
                      <ExpandedNodeDetails
                        node={node}
                        live={live}
                        lastReportTime={getNodeLastReportTime(node.uuid, liveData)}
                        status={status}
                        includeHidden={includeHidden}
                      />
                    </Table.Cell>
                  </Table.Row>
                )}
              </React.Fragment>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
