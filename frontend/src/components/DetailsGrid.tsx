import React from 'react';
import { Card, Popover, Text } from '@radix-ui/themes';
import {
  Cpu,
  Globe,
  HardDrive,
  Layers,
  MessageSquareText,
  Monitor,
  Network,
  Server,
  Wifi,
} from 'lucide-react';
import { formatBytes } from '../utils/format';
import { formatCpuSpec } from '../utils/cpuFormat';

interface DetailsGridProps {
  client: {
    cpu_name?: string;
    cpu_cores?: number;
    arch?: string;
    virtualization?: string;
    gpu_name?: string;
    os?: string;
    kernel_version?: string;
    mem_total?: number;
    swap_total?: number;
    disk_total?: number;
    region?: string;
    ipv4?: string;
    ipv6?: string;
    has_ipv4?: boolean;
    has_ipv6?: boolean;
    price?: number;
    currency?: string;
    billing_cycle?: number;
    remark?: string;
    version?: string;
  };
  live?: unknown;
  box?: boolean;
  align?: 'left' | 'center' | 'right';
  uuid?: string;
  compact?: boolean;
  remark?: string;
}

function formatSupport(supported?: boolean, sourceValue?: string) {
  return supported || Boolean(sourceValue) ? '支持' : '不支持';
}

function DetailItem({
  icon,
  label,
  value,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  const title = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

  return (
    <div className={`DetailsGrid-item${className ? ` ${className}` : ''}`}>
      <span className="DetailsGrid-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="DetailsGrid-copy">
        <Text size="1" weight="bold" className="DetailsGrid-label">
          {label}
        </Text>
        <Text size="1" color="gray" className="DetailsGrid-value" as="div" title={title}>
          {value || '-'}
        </Text>
      </span>
    </div>
  );
}

function DetailRemarkItem({ value }: { value: string }) {
  return (
    <div className="DetailsGrid-item DetailsGrid-remark-item">
      <span className="DetailsGrid-icon" aria-hidden="true">
        <MessageSquareText size={16} />
      </span>
      <span className="DetailsGrid-copy">
        <Text size="1" weight="bold" className="DetailsGrid-label">
          备注
        </Text>
        <Popover.Root>
          <Popover.Trigger>
            <button type="button" className="DetailsGrid-remark-trigger" title={value}>
              <Text size="1" color="gray" className="DetailsGrid-value DetailsGrid-remark-preview" as="span">
                {value}
              </Text>
            </button>
          </Popover.Trigger>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="DetailsGrid-remark-popover"
          >
            <Text size="1" weight="bold" className="DetailsGrid-label">
              备注
            </Text>
            <div className="DetailsGrid-remark-popover-body">
              {value}
            </div>
          </Popover.Content>
        </Popover.Root>
      </span>
    </div>
  );
}

export default function DetailsGrid({ client, box, align, compact, remark }: DetailsGridProps) {
  const Container: any = box ? Card : 'div';
  const ipValue = `IPv4 ${formatSupport(client.has_ipv4, client.ipv4)} / IPv6 ${formatSupport(client.has_ipv6, client.ipv6)}`;
  const normalizedRemark = remark?.trim();
  const agentItem = {
    label: 'Agent',
    value: client.version || '-',
    icon: <Network size={16} />,
  };

  const items = [
    {
      label: 'CPU',
      value: formatCpuSpec(client.cpu_name, client.cpu_cores),
      icon: <Cpu size={16} />,
    },
    {
      label: '架构',
      value: client.arch || '-',
      icon: <Server size={16} />,
    },
    {
      label: '虚拟化',
      value: client.virtualization || '-',
      icon: <Layers size={16} />,
    },
    {
      label: '操作系统',
      value: client.os || '-',
      icon: <Monitor size={16} />,
    },
    {
      label: '内核',
      value: client.kernel_version || '-',
      icon: <Network size={16} />,
    },
    {
      label: 'GPU',
      value: client.gpu_name || '-',
      icon: <Cpu size={16} />,
    },
    {
      label: '内存容量',
      value: formatBytes(client.mem_total || 0),
      icon: <Server size={16} />,
    },
    {
      label: '交换空间',
      value: formatBytes(client.swap_total || 0),
      icon: <HardDrive size={16} />,
    },
    {
      label: '磁盘容量',
      value: formatBytes(client.disk_total || 0),
      icon: <HardDrive size={16} />,
    },
    {
      label: 'IP 支持',
      value: ipValue,
      icon: <Wifi size={16} />,
    },
    {
      label: '地区',
      value: client.region || '-',
      icon: <Globe size={16} />,
    },
    agentItem,
  ];
  const firstRowItems = normalizedRemark ? items.slice(0, 5) : [];
  const resourceRowItems = normalizedRemark ? items.slice(5, 10) : [];
  const metaRowItems = normalizedRemark ? items.slice(10) : [];

  return (
    <Container className={`DetailsGrid${compact ? ' DetailsGrid-compact' : ''}`}>
      {normalizedRemark ? (
        <div className="DetailsGrid-stack" data-align={align || 'left'}>
          <div className="DetailsGrid-fixed-row">
            {firstRowItems.map((item) => (
              <DetailItem key={item.label} {...item} />
            ))}
          </div>
          <div className="DetailsGrid-fixed-row">
            {resourceRowItems.map((item) => (
              <DetailItem key={item.label} {...item} />
            ))}
          </div>
          <div className="DetailsGrid-meta-row">
            {metaRowItems.map((item) => (
              <DetailItem key={item.label} {...item} />
            ))}
            <DetailRemarkItem value={normalizedRemark} />
          </div>
        </div>
      ) : (
        <div className="DetailsGrid-list" data-align={align || 'left'}>
          {items.map((item) => (
            <DetailItem key={item.label} {...item} />
          ))}
        </div>
      )}
    </Container>
  );
}
