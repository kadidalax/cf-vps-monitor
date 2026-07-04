import { useEffect, useMemo, useState } from 'react';
import {
  Flex,
  Card,
  Text,
  Heading,
  Badge,
  Table,
  Select,
  TextField,
  Button,
  Dialog,
} from '@radix-ui/themes';
import { ScrollText, Search, Shield, Clock3, User, FileText } from 'lucide-react';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { getAuditLogDetailSearchText, getAuditLogDetailText, getAuditLogRawDetailText } from '../../utils/audit-log';
import { AuditLogEntry, normalizeAuditLogsPage } from '../../utils/audit-log-response';

const actionLabels: Record<string, { label: string; color: string }> = {
  login: { label: '登录', color: 'green' },
  account_username_edit: { label: '修改用户名', color: 'orange' },
  client_add: { label: '添加服务器', color: 'blue' },
  client_edit: { label: '编辑服务器', color: 'blue' },
  client_remove: { label: '删除服务器', color: 'red' },
  chpasswd: { label: '修改密码', color: 'orange' },
  agent_token_source_ip_change: { label: 'Token 来源变化', color: 'orange' },
  settings_save: { label: '保存设置', color: 'blue' },
  settings_edit: { label: '修改设置', color: 'blue' },
  ping_add: { label: '添加 Ping', color: 'blue' },
  ping_edit: { label: '编辑 Ping', color: 'blue' },
  ping_delete: { label: '删除 Ping', color: 'red' },
  offline_notification_edit: { label: '离线通知', color: 'orange' },
  load_notification_add: { label: '负载通知', color: 'blue' },
  load_notification_edit: { label: '编辑负载', color: 'blue' },
  load_notification_delete: { label: '删除负载', color: 'red' },
  record_clear: { label: '清除记录', color: 'red' },
  record_clear_all: { label: '清除全部', color: 'red' },
  backup_restore: { label: '恢复备份', color: 'purple' },
  cron_cleanup: { label: '定时清理', color: 'gray' },
  offline_notify: { label: '离线告警', color: 'red' },
  init: { label: '系统初始化', color: 'gray' },
};

function SummaryCards({
  logs,
}: {
  logs: AuditLogEntry[];
}) {
  const userCount = new Set(logs.map((log) => log.user).filter(Boolean)).size;
  const highRiskCount = logs.filter((log) =>
    ['client_remove', 'record_clear', 'record_clear_all', 'backup_restore', 'ping_delete', 'agent_token_source_ip_change'].includes(log.action || ''),
  ).length;
  const todayCount = logs.filter((log) => {
    const now = new Date();
    const date = new Date(log.time);
    return now.toDateString() === date.toDateString();
  }).length;

  const cards = [
    { title: '当前页日志', value: String(logs.length), icon: <FileText size={16} />, color: 'var(--blue-9)' },
    { title: '活跃用户', value: String(userCount), icon: <User size={16} />, color: 'var(--cyan-9)' },
    { title: '今日操作', value: String(todayCount), icon: <Clock3 size={16} />, color: 'var(--green-9)' },
    { title: '高风险动作', value: String(highRiskCount), icon: <Shield size={16} />, color: 'var(--red-9)' },
  ];

  return (
    <Flex className="audit-summary-action-row" justify="between" align="center" wrap="wrap" gap="3">
      <div className="audit-summary-strip">
        {cards.map((card) => (
          <div className="audit-summary-item" key={card.title}>
            <span className="audit-summary-icon" style={{ color: card.color }} aria-hidden="true">{card.icon}</span>
            <Text className="audit-summary-label" size="1" color="gray">{card.title}</Text>
            <Text className="audit-summary-value" size="3" weight="bold">{card.value}</Text>
          </div>
        ))}
      </div>
    </Flex>
  );
}

export default function AdminAuditLogs() {
  const apiFetch = useApi();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('50');
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/admin/logs?limit=${pageSize}&page=${page}`)
      .then(data => {
        if (cancelled) return;
        const pageData = normalizeAuditLogsPage(data);
        setLogs(pageData.logs);
        setTotal(pageData.total);
        setHasMore(pageData.hasMore);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setLogs([]);
        setTotal(0);
        setHasMore(false);
        setError(loadError instanceof Error ? loadError.message : '审计日志加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, page, pageSize]);

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (filter !== 'all' && log.action !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          log.action?.toLowerCase().includes(q) ||
          getAuditLogDetailSearchText(log.detail).toLowerCase().includes(q) ||
          log.user?.toLowerCase().includes(q) ||
          String(log.id).includes(q)
        );
      }
      return true;
    });
  }, [logs, filter, search]);

  const uniqueActions = Array.from(new Set(logs.map(l => l.action).filter((action): action is string => Boolean(action))));
  const knownPages = Math.max(page, Math.ceil(total / Number(pageSize || 50)));
  const pageLabel = hasMore ? `第 ${page} 页，至少 ${total} 条` : `第 ${page} / ${knownPages} 页，共 ${total} 条`;

  if (loading) return <Loading />;

  return (
    <div>
      <Flex className="admin-audit-page" direction="column" gap="2">
        <Flex className="admin-parent-title-row" align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <ScrollText size={20} />
            <Heading size="5">审计日志</Heading>
          </Flex>
        </Flex>

        <SummaryCards
          logs={logs}
        />

        {error && (
          <Card className="admin-error-card">
            <Text size="2" color="red" weight="bold">审计日志加载失败</Text>
            <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>{error}</Text>
          </Card>
        )}

        <Card>
          <div className="audit-filter-toolbar">
            <div className="audit-filter-top-row">
              <TextField.Root
                className="audit-filter-search"
                placeholder="搜索 ID、用户、动作、详情..."
                value={search}
                onChange={e => setSearch((e.target as HTMLInputElement).value)}
              >
                <TextField.Slot><Search size={14} /></TextField.Slot>
              </TextField.Root>

              <Select.Root value={filter} onValueChange={setFilter}>
                <Select.Trigger className="audit-action-select" />
                <Select.Content>
                  <Select.Item value="all">全部操作</Select.Item>
                  {uniqueActions.map(action => (
                    <Select.Item key={action} value={action}>
                      {actionLabels[action]?.label || action}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>

              <Select.Root value={pageSize} onValueChange={(value) => { setPage(1); setPageSize(value); }}>
                <Select.Trigger className="audit-page-size-select" />
                <Select.Content>
                  <Select.Item value="20">每页 20 条</Select.Item>
                  <Select.Item value="50">每页 50 条</Select.Item>
                  <Select.Item value="100">每页 100 条</Select.Item>
                </Select.Content>
              </Select.Root>

              <Flex className="audit-filter-result-row" align="center">
                <Badge variant="soft" color="blue">本页筛选结果 {filteredLogs.length}</Badge>
              </Flex>
            </div>
          </div>
        </Card>

        <Card className="audit-log-table-card">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell style={{ width: '84px' }}>ID</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell style={{ width: '170px' }}>时间</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell style={{ width: '120px' }}>用户</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell style={{ width: '140px' }}>操作</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>详情</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredLogs.map(log => {
                const actionInfo = log.action ? actionLabels[log.action] : undefined;
                return (
                  <Table.Row key={log.id}>
                    <Table.Cell>
                      <Button variant="ghost" size="1" onClick={() => setSelectedLog(log)}>
                        {log.id}
                      </Button>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" style={{ fontFamily: 'monospace' }}>
                        {new Date(log.time).toLocaleString('zh-CN')}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1">{log.user || '-'}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="1" variant="soft" color={(actionInfo?.color as any) || 'gray'}>
                        {actionInfo?.label || log.action || '-'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <button
                        type="button"
                        className="audit-detail-preview"
                        onClick={() => setSelectedLog(log)}
                        title="查看完整详情"
                        aria-label={`查看日志 ${log.id} 完整详情`}
                      >
                        {getAuditLogDetailText(log.detail)}
                      </button>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
          {filteredLogs.length === 0 && (
            <Text color="gray" align="center" style={{ padding: '20px', display: 'block' }}>
              {search || filter !== 'all' ? '没有匹配的日志' : '暂无日志记录'}
            </Text>
          )}
        </Card>

        <Flex justify="between" align="center" wrap="wrap" gap="3">
          <Text size="2" color="gray">
            {pageLabel}
          </Text>
          <Flex gap="2">
            <Button variant="soft" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </Button>
            <Button variant="soft" disabled={!hasMore} onClick={() => setPage((value) => value + 1)}>
              下一页
            </Button>
          </Flex>
        </Flex>
      </Flex>

      <Dialog.Root open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 620 }}>
          <Dialog.Title>日志详情</Dialog.Title>
          {selectedLog && (
            <Flex direction="column" gap="3">
              {(() => {
                const detailText = getAuditLogDetailText(selectedLog.detail);
                const rawDetailText = getAuditLogRawDetailText(selectedLog.detail);
                const showRawDetail = rawDetailText !== '-' && rawDetailText !== detailText;
                return (
                  <>
              <Flex justify="between" align="center">
                <Badge variant="soft" color={(selectedLog.action ? actionLabels[selectedLog.action]?.color as any : undefined) || 'gray'}>
                  {selectedLog.action ? actionLabels[selectedLog.action]?.label || selectedLog.action : '-'}
                </Badge>
                <Text size="1" color="gray">{new Date(selectedLog.time).toLocaleString('zh-CN')}</Text>
              </Flex>
              <Card>
                <Flex direction="column" gap="2">
                  <Text size="2"><strong>ID:</strong> {selectedLog.id}</Text>
                  <Text size="2"><strong>用户:</strong> {selectedLog.user || '-'}</Text>
                  <Text size="2"><strong>级别:</strong> {selectedLog.level || 'info'}</Text>
                  <Text size="2"><strong>动作:</strong> {selectedLog.action || '-'}</Text>
                  <Text size="2"><strong>详情:</strong></Text>
                  <Text className="audit-detail-full" size="2" color="gray">
                    {detailText}
                  </Text>
                  {showRawDetail && (
                    <>
                      <Text size="2"><strong>原始详情:</strong></Text>
                      <Text className="audit-detail-full" size="2" color="gray">
                        {rawDetailText}
                      </Text>
                    </>
                  )}
                </Flex>
              </Card>
                  </>
                );
              })()}
              <Flex justify="end">
                <Button variant="soft" onClick={() => setSelectedLog(null)}>关闭</Button>
              </Flex>
            </Flex>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
