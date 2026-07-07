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
import { formatBytes, formatPercent, formatSpeed, formatUptime } from '../utils/format';
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

function formatUptimeZh(seconds?: number): string {
  if (!seconds || seconds < 0) return '-';
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

function formatLastReport(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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

function getSortOrder(node: ClientInfo) {
  return typeof node.sort_order === 'number' && Number.isFinite(node.sort_order)
    ? node.sort_order
    : Number.MAX_SAFE_INTEGER;
}

function formatSupport(supported?: boolean, sourceValue?: string) {
  return supported || Boolean(sourceValue) ? '支持' : '不支持';
}

function ExpandedNodeDetails({
  node,
  live,
  lastReportTime,
  includeHidden = false,
}: {
  node: ClientInfo;
  live?: LiveRecord;
  lastReportTime?: number;
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
            <DetailRow label="内存" value={formatBytes(node.mem_total || live?.ram_total || 0)} />
            <DetailRow label="交换" value={formatBytes(node.swap_total || live?.swap_total || 0)} />
            <DetailRow label="磁盘" value={formatBytes(node.disk_total || live?.disk_total || 0)} />
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
              label="当前速率"
              value={`↑ ${formatSpeed(live?.net_out || 0)} ↓ ${formatSpeed(live?.net_in || 0)}`}
            />
            <DetailRow
              label="总流量"
              value={`↑ ${formatBytes(live?.net_total_up || 0)} ↓ ${formatBytes(live?.net_total_down || 0)}`}
            />
            <DetailRow label="IPv4" value={formatSupport(node.has_ipv4, node.ipv4)} />
            <DetailRow label="IPv6" value={formatSupport(node.has_ipv6, node.ipv6)} />
          </DetailSection>

          <DetailSection title="运行状态">
            <DetailRow label="运行时间" value={formatUptimeZh(live?.uptime)} />
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

export default function NodeTable({ nodes, liveData, includeHidden = false }: NodeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('manual');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const onlineSet = useMemo(() => new Set(liveData?.online || []), [liveData?.online]);
  const lastReportMap = useMemo(() => {
    const map = new Map<string, number>();
    (liveData.clients || []).forEach((client) => {
      if (client.uuid && client.lastReportTime) map.set(client.uuid, client.lastReportTime);
    });
    return map;
  }, [liveData.clients]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortKey(key);
    setSortDir('asc');
  };

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <ChevronsUpDown size={12} style={{ opacity: 0.35 }} />;
    return sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
  };

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      const aOnline = onlineSet.has(a.uuid);
      const bOnline = onlineSet.has(b.uuid);
      const aLive = liveData?.data?.[a.uuid];
      const bLive = liveData?.data?.[b.uuid];

      let cmp = 0;
      switch (sortKey) {
        case 'manual':
          cmp = getSortOrder(a) - getSortOrder(b);
          break;
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
        case 'os':
          cmp = (a.os || '').localeCompare(b.os || '');
          break;
        case 'status':
          cmp = Number(bOnline) - Number(aOnline);
          break;
        case 'cpu':
          cmp = (aLive?.cpu || 0) - (bLive?.cpu || 0);
          break;
        case 'ram':
          cmp = formatPercent(aLive?.ram || 0, a.mem_total) - formatPercent(bLive?.ram || 0, b.mem_total);
          break;
        case 'disk':
          cmp = formatPercent(aLive?.disk || 0, a.disk_total) - formatPercent(bLive?.disk || 0, b.disk_total);
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

      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [nodes, sortKey, sortDir, liveData, onlineSet]);

  const toggleExpanded = (uuid: string) => {
    setExpandedRows((current) =>
      current.includes(uuid)
        ? current.filter((item) => item !== uuid)
        : [...current, uuid],
    );
  };

  const SortHeader = ({
    column,
    children,
    style,
  }: {
    column: SortKey;
    children: React.ReactNode;
    style?: React.CSSProperties;
  }) => (
    <Table.ColumnHeaderCell
      style={{ cursor: 'pointer', whiteSpace: 'nowrap', ...style }}
      onClick={() => handleSort(column)}
    >
      <Flex align="center" gap="1">
        {children}
        <SortIcon column={column} />
      </Flex>
    </Table.ColumnHeaderCell>
  );

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
            <SortHeader column="name" style={{ width: 180 }}>名称</SortHeader>
            <SortHeader column="os" style={{ width: 132 }}>系统</SortHeader>
            <SortHeader column="status" style={{ width: 136 }}>状态</SortHeader>
            <SortHeader column="cpu" style={{ width: 118 }}>CPU</SortHeader>
            <SortHeader column="ram" style={{ width: 118 }}>内存</SortHeader>
            <SortHeader column="disk" style={{ width: 118 }}>硬盘</SortHeader>
            <SortHeader column="network" style={{ width: 142 }}>网络</SortHeader>
            <SortHeader column="price" style={{ width: 108 }}>价格</SortHeader>
            <SortHeader column="traffic" style={{ width: 166 }}>流量</SortHeader>
          </Table.Row>
        </Table.Header>

        <Table.Body>
          {sortedNodes.map((node) => {
            const isOnline = onlineSet.has(node.uuid);
            const live = liveData?.data?.[node.uuid];
            const cpuVal = live?.cpu || 0;
            const ramPct = formatPercent(live?.ram || 0, node.mem_total);
            const diskPct = formatPercent(live?.disk || 0, node.disk_total);
            const isExpanded = expandedRows.includes(node.uuid);
            const uptimeLabel = formatUptime(live?.uptime || 0);

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
                      onClick={(event) => event.stopPropagation()}
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
                      <Badge color={isOnline ? 'green' : 'red'} variant="soft" size="1">
                        {isOnline ? '在线' : '离线'}
                      </Badge>
                      {isOnline && (
                        <Text size="1" color="gray" className="node-uptime-nowrap" title={uptimeLabel}>
                          {uptimeLabel}
                        </Text>
                      )}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Box className="node-table-resource-cell">
                      <UsageBar value={cpuVal} showLabel={false} />
                      <Text size="1" color="gray">{cpuVal.toFixed(1)}%</Text>
                    </Box>
                  </Table.Cell>
                  <Table.Cell>
                    <Box className="node-table-resource-cell">
                      <UsageBar value={ramPct} showLabel={false} />
                      <Text size="1" color="gray">{ramPct.toFixed(1)}%</Text>
                    </Box>
                  </Table.Cell>
                  <Table.Cell>
                    <Box className="node-table-resource-cell">
                      <UsageBar value={diskPct} showLabel={false} />
                      <Text size="1" color="gray">{diskPct.toFixed(1)}%</Text>
                    </Box>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="2" style={{ whiteSpace: 'nowrap' }}>
                      ↑ {formatSpeed(live?.net_out || 0)} ↓ {formatSpeed(live?.net_in || 0)}
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
                      ↑ {formatBytes(live?.net_total_up || 0)} ↓ {formatBytes(live?.net_total_down || 0)}
                    </Text>
                  </Table.Cell>
                </Table.Row>

                {isExpanded && (
                  <Table.Row>
                    <Table.Cell colSpan={10} className="node-table-expanded-cell">
                      <ExpandedNodeDetails
                        node={node}
                        live={live}
                        lastReportTime={lastReportMap.get(node.uuid)}
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
