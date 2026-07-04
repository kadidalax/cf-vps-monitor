import { Badge, Box, Flex, Heading, Table, Text } from '@radix-ui/themes';
import { ExternalLink } from 'lucide-react';
import WebsiteHeartbeatBar from './WebsiteHeartbeatBar';
import type { WebsiteMonitorSummary } from './WebsiteMonitorList';

function statusLabel(status: WebsiteMonitorSummary['status']) {
  if (status === 'up') return '正常';
  if (status === 'down') return '失效';
  if (status === 'paused') return '暂停';
  return '等待检测';
}

export default function WebsiteMonitorDetails({ monitor }: { monitor: WebsiteMonitorSummary | null }) {
  if (!monitor) {
    return (
      <section className="kuma-monitor-details is-empty">
        <Text color="gray">暂无网站监控</Text>
      </section>
    );
  }
  const workerChecks = (monitor.checks || []).filter((check) => (check.source_type || 'worker') === 'worker');
  const agentChecks = (monitor.checks || []).filter((check) => check.source_type === 'agent').slice(0, 12);

  return (
    <section className="kuma-monitor-details">
      <Flex align="start" justify="between" gap="3" className="kuma-monitor-details-head">
        <Box>
          <Flex align="center" gap="2">
            <span className={`website-status-dot is-${monitor.status}`} />
            <Heading size="5">{monitor.name}</Heading>
            <Badge color={monitor.status === 'up' ? 'green' : monitor.status === 'down' ? 'red' : 'gray'} variant="soft">
              {statusLabel(monitor.status)}
            </Badge>
          </Flex>
          <a className="kuma-monitor-details-url" href={monitor.url} target="_blank" rel="noopener noreferrer">
            {monitor.url}
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </Box>
        <Box className="kuma-monitor-latency">
          <Text size="1" color="gray">延迟</Text>
          <Text size="5" weight="bold">{monitor.last_latency_ms ?? 0}ms</Text>
        </Box>
      </Flex>

      <Box className="kuma-monitor-heartbeat-panel">
        <WebsiteHeartbeatBar checks={workerChecks} max={60} />
      </Box>

      <div className="kuma-monitor-stats">
        <div>
          <Text size="1" color="gray">状态</Text>
          <Text size="4" weight="bold">{statusLabel(monitor.status)}</Text>
        </div>
        <div>
          <Text size="1" color="gray">最近检测</Text>
          <Text size="2">{monitor.last_checked_at ? new Date(monitor.last_checked_at).toLocaleString() : '-'}</Text>
        </div>
      </div>

      <Table.Root className="kuma-monitor-events" size="2" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>时间</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>状态</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>延迟</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {workerChecks.slice(0, 12).map((check) => (
            <Table.Row key={check.checked_at}>
              <Table.Cell>{new Date(check.checked_at).toLocaleString()}</Table.Cell>
              <Table.Cell>
                <Badge color={check.ok ? 'green' : 'red'} variant="soft">{check.ok ? 'UP' : 'DOWN'}</Badge>
              </Table.Cell>
              <Table.Cell>{check.latency_ms ?? 0}ms</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>

      {agentChecks.length > 0 && (
        <Table.Root className="kuma-monitor-events" size="2" variant="surface">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Agent</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>状态</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>延迟</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>时间</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {agentChecks.map((check) => (
              <Table.Row key={`${check.source_client || 'agent'}-${check.checked_at}`}>
                <Table.Cell>{check.source_client || '-'}</Table.Cell>
                <Table.Cell>
                  <Badge color={check.ok ? 'green' : 'red'} variant="soft">{check.ok ? 'UP' : 'DOWN'}</Badge>
                </Table.Cell>
                <Table.Cell>{check.latency_ms ?? 0}ms</Table.Cell>
                <Table.Cell>{new Date(check.checked_at).toLocaleString()}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </section>
  );
}
