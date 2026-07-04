import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  Heading,
  Select,
  Switch,
  Table,
  Tabs,
  Text,
  TextField,
} from '@radix-ui/themes';
import { Activity, ArrowDown, ArrowUp, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';

interface PingTask {
  id: number;
  name: string;
  clients: string[];
  all_clients: boolean;
  type: 'icmp' | 'tcp' | 'http' | string;
  target: string;
  interval_sec: number;
  sort_order?: number;
}

interface ClientLite {
  uuid: string;
  name: string;
  group?: string;
  region?: string;
}

type TaskScopeFilter = 'all' | 'global' | 'selected';
type TaskViewMode = 'task' | 'server';

function getTaskScopeLabel(task: PingTask, clients: ClientLite[]) {
  if (task.all_clients) return '所有服务器';
  if (!task.clients?.length) return '未绑定服务器';

  return task.clients
    .map((uuid) => clients.find((client) => client.uuid === uuid)?.name || uuid)
    .join(', ');
}

function TaskDialog({
  open,
  onOpenChange,
  clients,
  editingTask,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: ClientLite[];
  editingTask: PingTask | null;
  onSaved: (task?: PingTask) => void;
}) {
  const apiFetch = useApi();
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!open) return;

    if (editingTask) {
      setFormData({
        name: editingTask.name,
        type: editingTask.type,
        target: editingTask.target,
        clients: editingTask.clients || [],
        all_clients: editingTask.all_clients,
      });
      return;
    }

    setFormData({
      name: '',
      type: 'icmp',
      target: '',
      clients: [],
      all_clients: true,
    });
  }, [open, editingTask]);

  const selectedClients = (formData.clients as string[] | undefined) || [];
  const allClients = Boolean(formData.all_clients);

  const toggleClient = (uuid: string) => {
    if (selectedClients.includes(uuid)) {
      setFormData((prev) => ({ ...prev, clients: selectedClients.filter((id) => id !== uuid) }));
      return;
    }
    setFormData((prev) => ({ ...prev, clients: [...selectedClients, uuid] }));
  };

  const handleSave = async () => {
    const name = String(formData.name || '').trim();
    const target = String(formData.target || '').trim();

    if (!name) {
      toast.error('请输入任务名称');
      return;
    }

    if (!target) {
      toast.error('请输入目标地址');
      return;
    }

    if (!allClients && selectedClients.length === 0) {
      toast.error('请选择至少一个服务器，或启用所有服务器');
      return;
    }

    setSaving(true);

    const payload = {
      name,
      type: String(formData.type || 'icmp'),
      target,
      clients: allClients ? [] : selectedClients,
      all_clients: allClients,
    };

    try {
      const result = editingTask
        ? await apiFetch('/admin/ping/edit', {
          method: 'POST',
          body: JSON.stringify({ id: editingTask.id, ...payload }),
        })
        : await apiFetch('/admin/ping/add', {
          method: 'POST',
          body: JSON.stringify(payload),
        });

      if (result.success) {
        toast.success(editingTask ? '编辑成功' : '添加成功');
        onOpenChange(false);
        onSaved(result.task);
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 620 }}>
        <Dialog.Title>{editingTask ? '编辑 Ping 任务' : '添加 Ping 任务'}</Dialog.Title>
        <Flex direction="column" gap="3" style={{ padding: '8px 0', maxHeight: 560, overflow: 'auto' }}>
          <Grid columns={{ initial: '1', sm: '2' }} gap="3">
            <label>
              <Text size="2" weight="bold">名称</Text>
              <TextField.Root
                style={{ width: '100%', marginTop: 4 }}
                value={String(formData.name || '')}
                onChange={(event) => setFormData({ ...formData, name: event.target.value })}
              />
            </label>
            <label>
              <Text size="2" weight="bold">类型</Text>
              <Select.Root
                value={String(formData.type || 'icmp')}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
              >
                <Select.Trigger style={{ width: '100%', marginTop: 4 }} />
                <Select.Content>
                  <Select.Item value="icmp">ICMP Ping</Select.Item>
                  <Select.Item value="tcp">TCP Ping</Select.Item>
                  <Select.Item value="http">HTTP Ping</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
          </Grid>

          <label>
            <Text size="2" weight="bold">目标地址</Text>
            <Text size="1" color="gray" style={{ display: 'block', marginTop: 2 }}>
              ICMP 示例 1.1.1.1；TCP 示例 1.1.1.1:443；HTTP 示例 https://example.com
            </Text>
            <TextField.Root
              style={{ width: '100%', marginTop: 4 }}
              value={String(formData.target || '')}
              onChange={(event) => setFormData({ ...formData, target: event.target.value })}
            />
          </label>

          <Box style={{ border: '1px solid var(--gray-5)', borderRadius: 8, padding: 12 }}>
            <Flex direction="column" gap="3">
              <Flex align="center" justify="between" gap="3">
                <Flex direction="column">
                  <Text size="2" weight="bold">应用范围</Text>
                  <Text size="1" color="gray">支持应用到所有服务器，也支持绑定到指定服务器</Text>
                </Flex>
                <Flex align="center" gap="2">
                  <Switch checked={allClients} onCheckedChange={(value) => setFormData({ ...formData, all_clients: value })} />
                  <Text size="2">所有服务器</Text>
                </Flex>
              </Flex>

              <Flex gap="2" wrap="wrap">
                <Badge variant="soft" color={allClients ? 'green' : 'gray'}>
                  {allClients ? '当前为全局任务' : '当前为定向任务'}
                </Badge>
                {!allClients && (
                  <Badge variant="soft" color="blue">已选服务器 {selectedClients.length}</Badge>
                )}
              </Flex>

              {!allClients && (
                <Grid columns={{ initial: '1', sm: '2' }} gap="2">
                  {clients.map((client) => {
                    const selected = selectedClients.includes(client.uuid);
                    return (
                      <Box
                        key={client.uuid}
                        style={{
                          padding: 10,
                          cursor: 'pointer',
                          borderRadius: 6,
                          border: selected ? '1px solid var(--blue-8)' : '1px solid var(--gray-5)',
                          background: selected ? 'var(--blue-2)' : 'var(--color-panel-solid)',
                        }}
                        onClick={() => toggleClient(client.uuid)}
                      >
                        <Flex align="center" gap="2">
                          <Checkbox
                            checked={selected}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => toggleClient(client.uuid)}
                          />
                          <Flex direction="column" style={{ minWidth: 0 }}>
                            <Text size="2" weight="medium" truncate>{client.name}</Text>
                            <Text size="1" color="gray" truncate>
                              {(client.group || '未分组') + (client.region ? ` / ${client.region}` : '')}
                            </Text>
                          </Flex>
                        </Flex>
                      </Box>
                    );
                  })}
                </Grid>
              )}
            </Flex>
          </Box>
        </Flex>

        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function TaskRow({
  task,
  boundNames,
  onEdit,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  task: PingTask;
  boundNames: string;
  onEdit: (task: PingTask) => void;
  onDelete: (task: PingTask) => void;
  onMove: (task: PingTask, direction: 'up' | 'down') => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <Table.Row>
      <Table.Cell>
        <Flex direction="column" gap="1">
          <Text size="2" weight="bold">{task.name}</Text>
          <Text
            className="admin-ping-task-scope"
            size="1"
            color="gray"
            title={task.all_clients ? '默认应用到全部服务器' : (boundNames || '未绑定服务器')}
          >
            {task.all_clients ? '默认应用到全部服务器' : (boundNames || '未绑定服务器')}
          </Text>
        </Flex>
      </Table.Cell>
      <Table.Cell><Badge variant="soft">{task.type.toUpperCase()}</Badge></Table.Cell>
      <Table.Cell><Text size="1" style={{ fontFamily: 'monospace' }}>{task.target}</Text></Table.Cell>
      <Table.Cell>
        {task.all_clients ? (
          <Badge color="green">所有服务器</Badge>
        ) : (
          <Badge color="blue" variant="soft">{task.clients?.length || 0} 台服务器</Badge>
        )}
      </Table.Cell>
      <Table.Cell>
        <Flex gap="1" wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>
          <Button size="1" variant="soft" onClick={() => onMove(task, 'up')} disabled={!canMoveUp} title="上移" aria-label={`上移 ${task.name}`}>
            <ArrowUp size={13} />
          </Button>
          <Button size="1" variant="soft" onClick={() => onMove(task, 'down')} disabled={!canMoveDown} title="下移" aria-label={`下移 ${task.name}`}>
            <ArrowDown size={13} />
          </Button>
          <Button size="1" variant="soft" onClick={() => onEdit(task)}>
            <Pencil size={13} /> 编辑
          </Button>
          <Button size="1" variant="soft" color="red" onClick={() => onDelete(task)}>
            <Trash2 size={13} /> 删除
          </Button>
        </Flex>
      </Table.Cell>
    </Table.Row>
  );
}

export default function AdminPingTasks() {
  const apiFetch = useApi();
  const [tasks, setTasks] = useState<PingTask[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<PingTask | null>(null);
  const [deleteTask, setDeleteTask] = useState<PingTask | null>(null);
  const [viewMode, setViewMode] = useState<TaskViewMode>('task');
  const [taskSearch, setTaskSearch] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<TaskScopeFilter>('all');

  const loadData = useCallback(async () => {
    try {
      const tasksData = await apiFetch('/admin/ping');
      if (Array.isArray(tasksData)) setTasks(tasksData);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  const ensureClients = useCallback(async () => {
    if (clientsLoaded) return;
    try {
      const clientsData = await apiFetch('/admin/clients');
      if (Array.isArray(clientsData)) {
        setClients(clientsData);
        setClientsLoaded(true);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '服务器列表加载失败');
    }
  }, [apiFetch, clientsLoaded]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (viewMode === 'server') void ensureClients();
  }, [ensureClients, viewMode]);

  const scopedTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (scopeFilter === 'global' && !task.all_clients) return false;
      if (scopeFilter === 'selected' && task.all_clients) return false;
      return true;
    });
  }, [tasks, scopeFilter]);

  const filteredTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    return scopedTasks.filter((task) => {
      if (!query) return true;

      return [
        task.name,
        task.type,
        task.target,
        getTaskScopeLabel(task, clients),
      ].join(' ').toLowerCase().includes(query);
    });
  }, [scopedTasks, clients, taskSearch]);

  const serverRows = useMemo(() => {
    return clients.map((client) => ({
      client,
      boundTasks: scopedTasks.filter((task) => task.all_clients || task.clients?.includes(client.uuid)),
    }));
  }, [clients, scopedTasks]);

  const filteredServerRows = useMemo(() => {
    const query = serverSearch.trim().toLowerCase();
    if (!query) return serverRows;

    return serverRows.filter(({ client, boundTasks }) => [
      client.name,
      client.group,
      client.region,
      ...boundTasks.flatMap((task) => [task.name, task.type, task.target]),
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [serverRows, serverSearch]);

  const globalTaskCount = tasks.filter((task) => task.all_clients).length;
  const selectedTaskCount = tasks.length - globalTaskCount;
  const activeSearch = viewMode === 'task' ? taskSearch : serverSearch;
  const currentResultCount = viewMode === 'task' ? filteredTasks.length : filteredServerRows.length;

  const openAdd = () => {
    setEditingTask(null);
    setDialogOpen(true);
    void ensureClients();
  };

  const openEdit = (task: PingTask) => {
    setEditingTask(task);
    setDialogOpen(true);
    void ensureClients();
  };

  const handleDelete = async () => {
    if (!deleteTask) return;
    const result = await apiFetch('/admin/ping/delete', {
      method: 'POST',
      body: JSON.stringify({ id: deleteTask.id }),
    });
    if (result.success) {
      toast.success('删除成功');
      const deletedId = deleteTask.id;
      setDeleteTask(null);
      setTasks((current) => current.filter((task) => task.id !== deletedId));
    } else {
      toast.error(result.error || '删除失败');
    }
  };

  const moveTask = async (task: PingTask, direction: 'up' | 'down') => {
    const currentIndex = tasks.findIndex((item) => item.id === task.id);
    if (currentIndex < 0) return;
    const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= tasks.length) return;

    const nextTasks = [...tasks];
    [nextTasks[currentIndex], nextTasks[nextIndex]] = [nextTasks[nextIndex], nextTasks[currentIndex]];
    setTasks(nextTasks);

    try {
      const result = await apiFetch('/admin/ping/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids: nextTasks.map((item) => item.id) }),
      });

      if (result.success) {
        toast.success('排序已更新');
      } else {
        toast.error(result.error || '排序失败');
        loadData();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '排序失败');
      loadData();
    }
  };

  if (loading) return <Loading />;

  return (
    <Flex className="admin-ping-page" direction="column" gap="2">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Activity size={20} />
          <Heading size="5">延迟监测</Heading>
          <Badge size="1" variant="soft" color="gray">{tasks.length} 个任务</Badge>
        </Flex>
      </Flex>

      <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3">
        <Tabs.Root value={viewMode} onValueChange={(value) => setViewMode(value as TaskViewMode)}>
          <Tabs.List className="admin-subnav-row">
            <Tabs.Trigger value="task">任务视图</Tabs.Trigger>
            <Tabs.Trigger value="server">服务器视图</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
        <Button onClick={openAdd}><Plus size={16} /> 添加任务</Button>
      </Flex>

      <Card>
        <div className="admin-ping-filter-toolbar">
          <div className="admin-ping-filter-top-row">
            <TextField.Root
              className="admin-ping-search"
              placeholder={viewMode === 'task' ? '搜索任务' : '搜索服务器'}
              value={activeSearch}
              onChange={(event) => {
                if (viewMode === 'task') {
                  setTaskSearch(event.target.value);
                } else {
                  setServerSearch(event.target.value);
                }
              }}
            >
              <TextField.Slot><Search size={14} /></TextField.Slot>
            </TextField.Root>

            <Select.Root value={scopeFilter} onValueChange={(value) => setScopeFilter(value as TaskScopeFilter)}>
              <Select.Trigger className="admin-ping-scope-select" />
              <Select.Content>
                <Select.Item value="all">全部范围</Select.Item>
                <Select.Item value="global">全局任务</Select.Item>
                <Select.Item value="selected">定向任务</Select.Item>
              </Select.Content>
            </Select.Root>

            <Flex className="admin-ping-filter-stats" gap="2" wrap="wrap" align="center">
              <Badge variant="soft" color="blue">当前结果 {currentResultCount}</Badge>
              <Badge variant="soft" color="green">全局 {globalTaskCount}</Badge>
              <Badge variant="soft" color="amber">定向 {selectedTaskCount}</Badge>
            </Flex>
          </div>
        </div>
      </Card>

      {viewMode === 'task' ? (
        <Card style={{ overflowX: 'auto' }}>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>名称</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>类型</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>目标</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>应用范围</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell width="220px">操作</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredTasks.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={5}>
                    <Text color="gray" align="center" style={{ display: 'block', padding: 24 }}>
                      {taskSearch || scopeFilter !== 'all' ? '没有匹配的 Ping 任务' : '暂无 Ping 任务'}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ) : (
                filteredTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    boundNames={getTaskScopeLabel(task, clients)}
                    onEdit={openEdit}
                    onDelete={setDeleteTask}
                    onMove={moveTask}
                    canMoveUp={tasks.findIndex((item) => item.id === task.id) > 0}
                    canMoveDown={tasks.findIndex((item) => item.id === task.id) < tasks.length - 1}
                  />
                ))
              )}
            </Table.Body>
          </Table.Root>
        </Card>
      ) : (
        <div className="admin-ping-server-grid">
          {filteredServerRows.length === 0 ? (
            <div className="admin-ping-server-empty">
              <Text color="gray">
                {serverSearch || scopeFilter !== 'all' ? '没有匹配的服务器' : '暂无服务器'}
              </Text>
            </div>
          ) : (
            filteredServerRows.map(({ client, boundTasks }) => (
              <div className="admin-ping-server-card" key={client.uuid}>
                <Flex className="admin-ping-server-card-head" justify="between" align="start" gap="2">
                  <Box className="admin-ping-server-main">
                    <Text className="admin-ping-server-name" size="2" weight="bold" title={client.name}>
                      {client.name}
                    </Text>
                    <Flex className="admin-ping-server-meta" gap="1" wrap="wrap" align="center">
                      <Badge size="1" variant="soft" color="gray">{client.group || '未分组'}</Badge>
                      {client.region ? (
                        <Badge size="1" variant="soft">{client.region}</Badge>
                      ) : (
                        <Text size="1" color="gray">无区域</Text>
                      )}
                    </Flex>
                  </Box>
                  <Badge className="admin-ping-server-count" size="1" variant="soft" color={boundTasks.length > 0 ? 'blue' : 'gray'}>
                    {boundTasks.length} 项
                  </Badge>
                </Flex>

                <div className="admin-ping-server-task-list">
                  {boundTasks.length > 0 ? boundTasks.map((task) => (
                    <Badge
                      className="admin-ping-server-task-chip"
                      key={task.id}
                      size="1"
                      variant="soft"
                      color={task.all_clients ? 'green' : 'blue'}
                      title={`${task.name} / ${task.type.toUpperCase()} / ${task.target}`}
                    >
                      {task.name}
                    </Badge>
                  )) : (
                    <Text size="1" color="gray">暂无匹配任务</Text>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
      <TaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        clients={clients}
        editingTask={editingTask}
        onSaved={(task) => {
          if (!task) {
            loadData();
            return;
          }
          setTasks((current) => {
            const exists = current.some((item) => item.id === task.id);
            return exists
              ? current.map((item) => item.id === task.id ? task : item)
              : [...current, task].sort((a, b) => (a.sort_order || a.id || 0) - (b.sort_order || b.id || 0));
          });
        }}
      />

      <Dialog.Root open={Boolean(deleteTask)} onOpenChange={(open) => !open && setDeleteTask(null)}>
        <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 420 }}>
          <Dialog.Title>删除 Ping 任务</Dialog.Title>
          <Text size="2">
            确定删除 <strong>{deleteTask?.name}</strong> 吗？相关 Ping 记录也会被清理。
          </Text>
          <Flex gap="3" justify="end" mt="4">
            <Button variant="soft" onClick={() => setDeleteTask(null)}>取消</Button>
            <Button color="red" onClick={handleDelete}>确认删除</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
