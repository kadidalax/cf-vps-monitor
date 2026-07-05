import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  IconButton,
  Select,
  Switch,
  SegmentedControl,
  Table,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import { ExternalLink, Eye, EyeOff, Globe2, GripVertical, Pencil, Plus, Power, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import WebsiteHeartbeatBar from '../../components/WebsiteHeartbeatBar';
import { useApi } from '../../contexts/AuthContext';
import { notifyWebsiteMonitorsUpdated, subscribeWebsiteMonitorsUpdated, type WebsiteMonitorsUpdateDetail } from '../../utils/websiteMonitorEvents';

type WebsiteStatus = 'pending' | 'up' | 'down' | 'paused';
type WebsiteMethod = 'GET' | 'HEAD' | 'TCP';
type WebsiteAgentProbeMode = 'off' | 'selected' | 'country_auto';
type WebsiteStatusFilter = 'all' | 'up' | 'down' | 'hidden';
type WebsiteSortKey = 'manual' | 'name' | 'status';
type WebsiteSortDir = 'asc' | 'desc';

const DEFAULT_EXPECTED_STATUS_MIN = 200;
const DEFAULT_EXPECTED_STATUS_MAX = 399;

interface WebsiteMonitor {
  id: number;
  name: string;
  url: string;
  method: WebsiteMethod;
  expected_status_min: number;
  expected_status_max: number;
  interval_sec: number;
  timeout_sec: number;
  grace_period_sec: number;
  enabled: boolean;
  hidden: boolean;
  agent_probe_mode: WebsiteAgentProbeMode;
  agent_probe_clients: string[];
  agent_probe_limit: number;
  agent_probe_status_enabled: boolean;
  status: WebsiteStatus;
  last_checked_at: string | null;
  last_status_code: number | null;
  last_raw_status_code: number | null;
  last_latency_ms: number | null;
  last_effective_reason: string | null;
}

interface WebsiteCheck {
  checked_at: string;
  ok: boolean;
  latency_ms: number | null;
}

interface ClientLite {
  uuid: string;
  name: string;
  region?: string;
}

const emptyForm = {
  name: '',
  url: 'https://',
  method: 'GET' as WebsiteMethod,
  expected_status_min: DEFAULT_EXPECTED_STATUS_MIN,
  expected_status_max: DEFAULT_EXPECTED_STATUS_MAX,
  interval_sec: 120,
  timeout_sec: 10,
  grace_period_sec: 180,
  enabled: true,
  hidden: false,
  agent_probe_mode: 'country_auto' as WebsiteAgentProbeMode,
  agent_probe_clients: [] as string[],
  agent_probe_limit: 3,
  agent_probe_status_enabled: true,
};

function statusLabel(status: WebsiteStatus) {
  if (status === 'up') return '正常';
  if (status === 'down') return '失效';
  if (status === 'paused') return '暂停';
  return '等待';
}

function statusColor(status: WebsiteStatus) {
  if (status === 'up') return 'green';
  if (status === 'down') return 'red';
  return 'gray';
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function effectiveReasonLabel(value: string | null) {
  if (value === 'tcp_connect') return 'TCP 端口可连接';
  if (value === 'reachable_challenge') return '目标可达，返回风控/挑战响应';
  if (value === 'status_in_expected_range') return '原始状态码在正常范围内';
  if (value === 'http_status_mismatch') return '原始状态码不在正常范围内';
  if (value === 'timeout') return '检测超时';
  if (value === 'dns_error') return 'DNS 解析失败';
  if (value === 'tls_error') return 'TLS/证书错误';
  if (value === 'network_error') return '网络错误';
  return value || '暂无判定原因';
}

function rawStatusLabel(monitor: WebsiteMonitor) {
  if (monitor.method === 'TCP') {
    if (monitor.last_latency_ms == null) return '-';
    return monitor.status === 'up' ? 'TCP 可达' : effectiveReasonLabel(monitor.last_effective_reason);
  }
  const statusCode = monitor.last_raw_status_code ?? monitor.last_status_code;
  return statusCode == null ? '-' : `HTTP ${statusCode}`;
}

function assertSuccess(result: unknown, fallback: string) {
  const data = result as { success?: boolean; error?: string } | null;
  if (!data?.success) throw new Error(data?.error || fallback);
}

function applyWebsiteMonitorUpdate(current: WebsiteMonitor[], detail?: WebsiteMonitorsUpdateDetail | true): WebsiteMonitor[] | null {
  if (!detail || detail === true) return null;
  const remove = new Set((detail.remove || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  const byId = new Map(current.filter((monitor) => !remove.has(monitor.id)).map((monitor) => [monitor.id, monitor]));
  for (const raw of detail.upsert || []) {
    if (!raw || typeof raw !== 'object') continue;
    const monitor = raw as Partial<WebsiteMonitor>;
    const id = Number(monitor.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    byId.set(id, { ...byId.get(id), ...monitor, id } as WebsiteMonitor);
  }
  const next = [...byId.values()];
  if (detail.reorder?.length) {
    const order = new Map(detail.reorder.map((id, index) => [Number(id), index]));
    next.sort((a, b) => (order.get(a.id) ?? next.length) - (order.get(b.id) ?? next.length));
  }
  return next;
}

interface SortableWebsiteRowProps {
  monitor: WebsiteMonitor;
  selected: boolean;
  dragDisabled: boolean;
  onSelect: (id: number) => void;
  onCheck: (monitor: WebsiteMonitor) => void;
  onVisibility: (monitor: WebsiteMonitor, hidden: boolean) => void;
  onEnabled: (monitor: WebsiteMonitor, enabled: boolean) => void;
  onEdit: (monitor: WebsiteMonitor) => void;
  onRemove: (monitor: WebsiteMonitor) => void;
}

function SortableWebsiteRow({ monitor, selected, dragDisabled, onSelect, onCheck, onVisibility, onEnabled, onEdit, onRemove }: SortableWebsiteRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: monitor.id,
    disabled: dragDisabled,
  });

  const rowStyle = {
    opacity: isDragging ? 0.72 : 1,
    transform: CSS.Transform.toString(transform),
    transition,
    position: 'relative' as const,
    zIndex: isDragging ? 2 : 0,
  };

  return (
    <Table.Row ref={setNodeRef} className={`admin-table-row admin-website-table-row${selected ? ' is-selected' : ''}`} style={rowStyle}>
      <Table.Cell className="admin-website-control-cell">
        <Flex className="admin-website-row-controls" align="center" gap="1">
          <Tooltip content={dragDisabled ? '切到手动排序后可拖拽' : '拖拽排序'}>
            <button
              type="button"
              className="admin-row-drag-handle"
              aria-label={`拖拽排序 ${monitor.name}`}
              disabled={dragDisabled}
              {...attributes}
              {...listeners}
            >
              <GripVertical size={15} />
            </button>
          </Tooltip>
          <Checkbox className="admin-node-checkbox" checked={selected} onCheckedChange={() => onSelect(monitor.id)} />
        </Flex>
      </Table.Cell>
      <Table.RowHeaderCell className="admin-website-name-cell">
        <Flex align="center" gap="2">
          <span className={`website-status-dot is-${monitor.status}`} />
          <Text weight="bold" className="admin-website-name-text">{monitor.name}</Text>
        </Flex>
      </Table.RowHeaderCell>
      <Table.Cell className="admin-website-url-cell">
        <a className="admin-website-url" href={monitor.url} target="_blank" rel="noopener noreferrer">
          {monitor.url}<ExternalLink size={12} aria-hidden="true" />
        </a>
      </Table.Cell>
      <Table.Cell className="admin-website-status-cell">
        <Badge color={statusColor(monitor.status)} variant="soft">{statusLabel(monitor.status)}</Badge>
      </Table.Cell>
      <Table.Cell className="admin-website-raw-cell" title={effectiveReasonLabel(monitor.last_effective_reason)}>
        {rawStatusLabel(monitor)}
      </Table.Cell>
      <Table.Cell className="admin-website-interval-cell">{monitor.interval_sec}s</Table.Cell>
      <Table.Cell className="admin-website-checked-cell">{formatTime(monitor.last_checked_at)}</Table.Cell>
      <Table.Cell className="admin-website-visibility-cell">{monitor.hidden ? '对游客隐藏' : '公开'}</Table.Cell>
      <Table.Cell className="admin-website-actions-cell">
        <Flex className="admin-website-row-actions" gap="1" align="center" wrap="wrap">
          <Button size="1" variant="soft" onClick={() => onCheck(monitor)}><RefreshCw size={13} />检测</Button>
          <Button size="1" variant="soft" onClick={() => onVisibility(monitor, !monitor.hidden)}>
            {monitor.hidden ? <Eye size={13} /> : <EyeOff size={13} />}{monitor.hidden ? '公开' : '隐藏'}
          </Button>
          <Button size="1" variant="soft" onClick={() => onEnabled(monitor, !monitor.enabled)}>
            {monitor.enabled ? '停用' : '启用'}
          </Button>
          <Button size="1" variant="soft" onClick={() => onEdit(monitor)}><Pencil size={13} />编辑</Button>
          <Button size="1" color="red" variant="soft" onClick={() => onRemove(monitor)}><Trash2 size={13} />删除</Button>
        </Flex>
      </Table.Cell>
    </Table.Row>
  );
}

function SortableWebsiteCard({ monitor, selected, dragDisabled, onSelect, onCheck, onEnabled, onEdit, onRemove }: SortableWebsiteRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: monitor.id,
    disabled: dragDisabled,
  });

  const cardStyle = {
    opacity: isDragging ? 0.72 : 1,
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} className={`admin-website-card-shell${isDragging ? ' is-dragging' : ''}`} style={cardStyle}>
      <Card className={`admin-node-card admin-website-card${selected ? ' is-selected' : ''}`}>
        <div className="admin-website-card-header">
          <div className="admin-node-card-controls">
            <Tooltip content={dragDisabled ? '切到手动排序后可拖拽' : '拖拽排序'}>
              <button
                type="button"
                className="admin-row-drag-handle"
                aria-label={`拖拽排序 ${monitor.name}`}
                disabled={dragDisabled}
                {...attributes}
                {...listeners}
              >
                <GripVertical size={15} />
              </button>
            </Tooltip>
            <Checkbox className="admin-node-checkbox" checked={selected} onCheckedChange={() => onSelect(monitor.id)} />
          </div>

          <div className="admin-website-card-title">
            <Flex align="center" gap="2">
              <span className={`website-status-dot is-${monitor.status}`} />
              <Text weight="bold" className="admin-website-name-text">{monitor.name}</Text>
            </Flex>
            <Flex className="admin-node-card-badges" align="center" gap="1" wrap="wrap">
              <Badge color={statusColor(monitor.status)} variant="soft">{statusLabel(monitor.status)}</Badge>
              <Badge color={monitor.enabled ? 'green' : 'gray'} variant="soft">{monitor.enabled ? '启用' : '停用'}</Badge>
              {monitor.hidden && <Badge color="orange" variant="soft">隐藏</Badge>}
            </Flex>
          </div>

          <Flex className="admin-row-actions">
            <Tooltip content="检测"><IconButton size="1" variant="soft" onClick={() => onCheck(monitor)}><RefreshCw size={13} /></IconButton></Tooltip>
            <Tooltip content={monitor.enabled ? '停用' : '启用'}><IconButton size="1" variant="soft" onClick={() => onEnabled(monitor, !monitor.enabled)} aria-label={monitor.enabled ? '停用' : '启用'}><Power size={13} /></IconButton></Tooltip>
            <Tooltip content="编辑"><IconButton size="1" variant="soft" onClick={() => onEdit(monitor)}><Pencil size={13} /></IconButton></Tooltip>
            <Tooltip content="删除"><IconButton size="1" color="red" variant="soft" onClick={() => onRemove(monitor)}><Trash2 size={13} /></IconButton></Tooltip>
          </Flex>
        </div>

        <div className="admin-website-card-body">
          <a className="admin-website-url admin-website-card-url" href={monitor.url} target="_blank" rel="noopener noreferrer">
            {monitor.url}<ExternalLink size={12} aria-hidden="true" />
          </a>
          <div className="admin-website-card-meta-grid">
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">原始响应</Text>
              <Text size="1" title={effectiveReasonLabel(monitor.last_effective_reason)}>{rawStatusLabel(monitor)}</Text>
            </div>
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">检测</Text>
              <Text size="1">{monitor.interval_sec}s</Text>
            </div>
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">最近检测</Text>
              <Text size="1">{formatTime(monitor.last_checked_at)}</Text>
            </div>
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">显示</Text>
              <Text size="1">{monitor.hidden ? '对游客隐藏' : '公开'}</Text>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function AdminWebsites() {
  const apiFetch = useApi();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [monitors, setMonitors] = useState<WebsiteMonitor[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [checks, setChecks] = useState<WebsiteCheck[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<WebsiteStatusFilter>('all');
  const [sortKey, setSortKey] = useState<WebsiteSortKey>('manual');
  const [sortDir, setSortDir] = useState<WebsiteSortDir>('asc');
  const [editOpen, setEditOpen] = useState(false);
  const [editMonitor, setEditMonitor] = useState<WebsiteMonitor | null>(null);
  const [deleteMonitor, setDeleteMonitor] = useState<WebsiteMonitor | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [selectedWebsites, setSelectedWebsites] = useState<number[]>([]);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const editDialogRef = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const statusFiltered = monitors.filter((monitor) => {
      if (statusFilter === 'up') return monitor.status === 'up';
      if (statusFilter === 'down') return monitor.status === 'down';
      if (statusFilter === 'hidden') return monitor.hidden;
      return true;
    });
    const searched = needle ? statusFiltered.filter((monitor) => `${monitor.name} ${monitor.url}`.toLowerCase().includes(needle)) : statusFiltered;
    if (sortKey === 'manual') return searched;
    return [...searched].sort((a, b) => {
      const left = sortKey === 'name' ? a.name : a.status;
      const right = sortKey === 'name' ? b.name : b.status;
      const result = left.localeCompare(right, 'zh-Hans-CN');
      return sortDir === 'asc' ? result : -result;
    });
  }, [monitors, search, sortDir, sortKey, statusFilter]);
  const filteredIds = useMemo(() => filtered.map((monitor) => monitor.id), [filtered]);
  const dragDisabled = sortKey !== 'manual' || Boolean(search.trim()) || statusFilter !== 'all';
  const selectedVisibleCount = useMemo(() => {
    const visible = new Set(filteredIds);
    return selectedWebsites.filter((id) => visible.has(id)).length;
  }, [filteredIds, selectedWebsites]);
  const allFilteredSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;

  const overview = useMemo(() => ({
    total: monitors.length,
    up: monitors.filter((monitor) => monitor.status === 'up').length,
    down: monitors.filter((monitor) => monitor.status === 'down').length,
    hidden: monitors.filter((monitor) => monitor.hidden).length,
  }), [monitors]);

  const loadMonitors = async (refresh = false) => {
    const data = await apiFetch(refresh ? '/admin/websites?refresh=1' : '/admin/websites');
    const list = Array.isArray(data) ? data as WebsiteMonitor[] : [];
    setMonitors(list);
  };

  const loadChecks = async (id: number) => {
    const data = await apiFetch(`/admin/websites/${id}/checks?limit=60`);
    setChecks(Array.isArray(data) ? data as WebsiteCheck[] : []);
  };

  const ensureClients = async () => {
    if (clientsLoaded) return;
    const data = await apiFetch('/admin/clients');
    if (Array.isArray(data)) {
      setClients(data as ClientLite[]);
      setClientsLoaded(true);
    }
  };

  useEffect(() => {
    loadMonitors()
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : '加载失败'))
      .finally(() => setLoading(false));
    const unsubscribe = subscribeWebsiteMonitorsUpdated((detail) => {
      if (detail && detail !== true) {
        setMonitors((current) => applyWebsiteMonitorUpdate(current, detail) || current);
        return;
      }
      loadMonitors(true).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '加载失败'));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!editMonitor) return;
    loadChecks(editMonitor.id).catch(() => setChecks([]));
  }, [editMonitor?.id]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const updateMobile = () => setIsMobile(media.matches);
    updateMobile();
    media.addEventListener('change', updateMobile);
    return () => media.removeEventListener('change', updateMobile);
  }, []);

  const update = (key: keyof typeof emptyForm, value: string | number | boolean | string[]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleAgentProbeClient = (uuid: string, checked: boolean | 'indeterminate') => {
    setForm((prev) => {
      const current = new Set(prev.agent_probe_clients);
      if (checked === true) current.add(uuid);
      else current.delete(uuid);
      return { ...prev, agent_probe_clients: Array.from(current) };
    });
  };

  const updateMethod = (method: WebsiteMethod) => {
    setForm((prev) => ({
      ...prev,
      method,
      url: method === 'TCP' && prev.url === 'https://' ? 'tcp://' : method !== 'TCP' && prev.url === 'tcp://' ? 'https://' : prev.url,
    }));
  };

  const openEdit = (monitor: WebsiteMonitor | null) => {
    ensureClients().catch((error: unknown) => toast.error(error instanceof Error ? error.message : '服务列表加载失败'));
    setEditMonitor(monitor);
    setForm(monitor ? {
      name: monitor.name,
      url: monitor.url,
      method: monitor.method,
      expected_status_min: monitor.expected_status_min,
      expected_status_max: monitor.expected_status_max,
      interval_sec: monitor.interval_sec,
      timeout_sec: monitor.timeout_sec,
      grace_period_sec: monitor.grace_period_sec,
      enabled: monitor.enabled,
      hidden: monitor.hidden,
      agent_probe_mode: monitor.agent_probe_mode || 'off',
      agent_probe_clients: Array.isArray(monitor.agent_probe_clients) ? monitor.agent_probe_clients : [],
      agent_probe_limit: monitor.agent_probe_limit || 3,
      agent_probe_status_enabled: Boolean(monitor.agent_probe_status_enabled),
    } : emptyForm);
    if (!monitor) setChecks([]);
    setEditOpen(true);
  };

  const save = async () => {
    const numericValues = form.method === 'TCP'
      ? [form.interval_sec, form.timeout_sec, form.grace_period_sec]
      : [form.expected_status_min, form.expected_status_max, form.interval_sec, form.timeout_sec, form.grace_period_sec];
    if (!form.name.trim() || !form.url.trim()) {
      toast.error(form.method === 'TCP' ? '请输入名称和 TCP 地址' : '请输入名称和网址');
      return;
    }
    if (numericValues.some((value) => !Number.isFinite(value) || value <= 0)) {
      toast.error('检测参数必须大于 0');
      return;
    }
    if (form.method !== 'TCP' && form.expected_status_min > form.expected_status_max) {
      toast.error('最小状态码不能大于最大状态码');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, name: form.name.trim(), url: form.url.trim() };
      const result = editMonitor
        ? await apiFetch('/admin/websites/edit', { method: 'POST', body: JSON.stringify({ id: editMonitor.id, ...payload }) })
        : await apiFetch('/admin/websites/add', { method: 'POST', body: JSON.stringify(payload) });
      assertSuccess(result, '保存失败');
      const savedMonitor = (result as { monitor?: WebsiteMonitor }).monitor;
      setMonitors((current) => {
        if (editMonitor) {
          return current.map((monitor) => monitor.id === editMonitor.id
            ? { ...monitor, ...(savedMonitor || payload) }
            : monitor);
        }
        return savedMonitor ? [...current, savedMonitor] : current;
      });
      toast.success(editMonitor ? '已保存' : '已添加');
      setEditOpen(false);
      notifyWebsiteMonitorsUpdated(savedMonitor ? { upsert: [savedMonitor] } : true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const setVisibility = async (monitor: WebsiteMonitor, hidden: boolean) => {
    const result = await apiFetch('/admin/websites/visibility', {
      method: 'POST',
      body: JSON.stringify({ id: monitor.id, hidden }),
    });
    assertSuccess(result, '设置失败');
    setMonitors((current) => current.map((item) => item.id === monitor.id ? { ...item, hidden } : item));
    notifyWebsiteMonitorsUpdated({ upsert: [{ ...monitor, hidden }] });
  };

  const setEnabled = async (monitor: WebsiteMonitor, enabled: boolean) => {
    const result = await apiFetch('/admin/websites/enabled', {
      method: 'POST',
      body: JSON.stringify({ id: monitor.id, enabled }),
    });
    assertSuccess(result, '设置失败');
    setMonitors((current) => current.map((item) => item.id === monitor.id
      ? { ...item, enabled, status: enabled && item.status === 'paused' ? 'pending' : !enabled ? 'paused' : item.status }
      : item));
    notifyWebsiteMonitorsUpdated({ upsert: [{ ...monitor, enabled, status: enabled && monitor.status === 'paused' ? 'pending' : !enabled ? 'paused' : monitor.status }] });
  };

  const toggleSelect = (id: number) => {
    setSelectedWebsites((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  const toggleSelectAll = () => {
    const visible = new Set(filteredIds);
    setSelectedWebsites((prev) => {
      if (filteredIds.length > 0 && filteredIds.every((id) => prev.includes(id))) {
        return prev.filter((id) => !visible.has(id));
      }
      return Array.from(new Set([...prev, ...filteredIds]));
    });
  };

  const setSelectedVisibility = async (hidden: boolean) => {
    const targets = monitors.filter((monitor) => selectedWebsites.includes(monitor.id));
    try {
      await Promise.all(targets.map((monitor) => apiFetch('/admin/websites/visibility', {
        method: 'POST',
        body: JSON.stringify({ id: monitor.id, hidden }),
      }).then((result) => assertSuccess(result, '设置失败'))));
      toast.success(`已${hidden ? '隐藏' : '公开'} ${targets.length} 个网站`);
      setSelectedWebsites([]);
      const ids = new Set(targets.map((monitor) => monitor.id));
      setMonitors((current) => current.map((monitor) => ids.has(monitor.id) ? { ...monitor, hidden } : monitor));
      notifyWebsiteMonitorsUpdated({
        upsert: targets.map((monitor) => ({ ...monitor, hidden })),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '设置失败');
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || dragDisabled) return;

    const oldIndex = monitors.findIndex((monitor) => monitor.id === Number(active.id));
    const newIndex = monitors.findIndex((monitor) => monitor.id === Number(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const previousMonitors = monitors;
    const nextMonitors = arrayMove(monitors, oldIndex, newIndex).map((monitor, index) => ({
      ...monitor,
      sort_order: index + 1,
    }));
    setMonitors(nextMonitors);

    try {
      const result = await apiFetch('/admin/websites/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids: nextMonitors.map((monitor) => monitor.id) }),
      });
      assertSuccess(result, '排序失败');
      toast.success('网站排序已更新');
      notifyWebsiteMonitorsUpdated({ upsert: nextMonitors, reorder: nextMonitors.map((monitor) => monitor.id) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '排序失败');
      setMonitors(previousMonitors);
      await loadMonitors();
    }
  };

  const remove = async (monitor: WebsiteMonitor) => {
    setDeleting(true);
    try {
      const result = await apiFetch('/admin/websites/delete', { method: 'POST', body: JSON.stringify({ id: monitor.id }) });
      assertSuccess(result, '删除失败');
      toast.success('已删除');
      setEditOpen(false);
      setDeleteMonitor(null);
      setMonitors((current) => current.filter((item) => item.id !== monitor.id));
      setSelectedWebsites((current) => current.filter((id) => id !== monitor.id));
      notifyWebsiteMonitorsUpdated({ remove: [monitor.id] });
    } finally {
      setDeleting(false);
    }
  };

  const checkNow = async (monitor: WebsiteMonitor) => {
    const result = await apiFetch(`/admin/websites/${monitor.id}/check`, { method: 'POST', body: JSON.stringify({}) });
    assertSuccess(result, '检测失败');
    const updatedMonitor = (result as { monitor?: WebsiteMonitor }).monitor;
    if (updatedMonitor) {
      setMonitors((current) => current.map((item) => item.id === updatedMonitor.id ? { ...item, ...updatedMonitor } : item));
    }
    toast.success('检测完成');
    await loadChecks(monitor.id);
    notifyWebsiteMonitorsUpdated(updatedMonitor ? { upsert: [updatedMonitor] } : true);
  };

  if (loading) return <Loading />;

  return (
    <Flex className="admin-websites-page" direction="column" gap="3">
      <Flex className="admin-parent-title-row admin-server-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Globe2 size={20} />
          <Text size="5" weight="bold">网站</Text>
        </Flex>
        <section className="admin-page-hero admin-server-overview-hero admin-website-overview-hero">
          <div className="admin-overview-strip">
            <div className="admin-overview-item">
              <Flex align="center" gap="2" className="admin-overview-line"><Text size="2">全部</Text><Text size="4" weight="bold">{overview.total}</Text></Flex>
            </div>
            <div className="admin-overview-item">
              <Flex align="center" gap="2" className="admin-overview-line"><Text size="2">正常</Text><Text size="4" weight="bold">{overview.up}</Text></Flex>
            </div>
            <div className="admin-overview-item">
              <Flex align="center" gap="2" className="admin-overview-line"><Text size="2">失效</Text><Text size="4" weight="bold">{overview.down}</Text></Flex>
            </div>
            <div className="admin-overview-item">
              <Flex align="center" gap="2" className="admin-overview-line"><Text size="2">隐藏</Text><Text size="4" weight="bold">{overview.hidden}</Text></Flex>
            </div>
          </div>
        </section>
      </Flex>

      <Card className="admin-filter-card">
        <Flex className="admin-filter-toolbar" direction="column" gap="2">
          <Flex className="admin-filter-primary-row" gap="2" align="center">
            <Box className="admin-status-filter">
              <SegmentedControl.Root value={statusFilter} onValueChange={(value) => setStatusFilter(value as WebsiteStatusFilter)} size="1">
                <SegmentedControl.Item value="all">全部</SegmentedControl.Item>
                <SegmentedControl.Item value="up">正常</SegmentedControl.Item>
                <SegmentedControl.Item value="down">失效</SegmentedControl.Item>
                <SegmentedControl.Item value="hidden">隐藏</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Box>

            <Flex className="admin-search-cluster" gap="2" align="center">
              <TextField.Root className="admin-server-search" size="1" placeholder="查找网站" value={search} onChange={(event) => setSearch(event.target.value)}>
                <TextField.Slot><Search size={14} /></TextField.Slot>
              </TextField.Root>
              <IconButton className="admin-refresh-button" variant="soft" size="1" onClick={() => loadMonitors(true).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '加载失败'))} title="刷新"><RefreshCw size={14} /></IconButton>
            </Flex>

            <Box className="admin-filter-group-select admin-filter-spacer" aria-hidden="true" />

            <Flex className="admin-sort-controls" gap="2" align="center">
              <SegmentedControl.Root value={sortKey} onValueChange={(value) => setSortKey(value as WebsiteSortKey)} size="1">
                <SegmentedControl.Item value="manual">手动</SegmentedControl.Item>
                <SegmentedControl.Item value="name">名称</SegmentedControl.Item>
                <SegmentedControl.Item value="status">状态</SegmentedControl.Item>
              </SegmentedControl.Root>
              <Button className="admin-sort-dir-button" variant="soft" size="1" disabled={sortKey === 'manual'} onClick={() => setSortDir((value) => value === 'asc' ? 'desc' : 'asc')}>
                {sortDir === 'asc' ? '升序' : '降序'}
              </Button>
            </Flex>
            <Button className="admin-add-server-button" size="1" onClick={() => openEdit(null)}><Plus size={16} /> 添加网站</Button>
          </Flex>
        </Flex>
      </Card>

      <Card className="admin-node-card-panel admin-website-table-card">
        <Flex className="admin-node-card-panel-header" justify="between" align="center" gap="2">
          <Text size="2" weight="bold">网站监控</Text>
          <Flex align="center" gap="2" wrap="wrap">
            {selectedWebsites.length > 0 && (
              <Flex className="admin-selection-inline admin-website-selection-inline" gap="2" align="center">
                <Badge variant="soft" color="blue">已选 {selectedWebsites.length}</Badge>
                {selectedVisibleCount !== selectedWebsites.length && (
                  <Text size="1" color="gray">当前结果 {selectedVisibleCount}</Text>
                )}
                <Button variant="soft" size="1" onClick={() => setSelectedVisibility(true)}>
                  <EyeOff size={14} /> 隐藏
                </Button>
                <Button variant="soft" size="1" onClick={() => setSelectedVisibility(false)}>
                  <Eye size={14} /> 公开
                </Button>
                <Button variant="ghost" size="1" onClick={() => setSelectedWebsites([])}>清除</Button>
              </Flex>
            )}
            <Text size="1" color="gray">当前 {filtered.length} 个</Text>
          </Flex>
        </Flex>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filteredIds} strategy={rectSortingStrategy}>
            {isMobile ? (
              <div className="admin-website-card-grid">
                {filtered.map((monitor) => (
                  <SortableWebsiteCard
                    key={monitor.id}
                    monitor={monitor}
                    selected={selectedWebsites.includes(monitor.id)}
                    dragDisabled={dragDisabled}
                    onSelect={toggleSelect}
                    onCheck={(target) => checkNow(target).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '检测失败'))}
                    onVisibility={(target, hidden) => setVisibility(target, hidden).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '设置失败'))}
                    onEnabled={(target, enabled) => setEnabled(target, enabled).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '设置失败'))}
                    onEdit={openEdit}
                    onRemove={setDeleteMonitor}
                  />
                ))}
              </div>
            ) : (
              <div className="admin-website-table-wrap">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell className="admin-website-control-cell">
                        <Checkbox checked={allFilteredSelected} onCheckedChange={toggleSelectAll} />
                      </Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-name-cell">名称</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-url-cell">网址</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-status-cell">状态</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-raw-cell">原始响应</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-interval-cell">检测</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-checked-cell">最近检测</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-visibility-cell">显示</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell className="admin-website-actions-cell">操作</Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {filtered.map((monitor) => (
                      <SortableWebsiteRow
                        key={monitor.id}
                        monitor={monitor}
                        selected={selectedWebsites.includes(monitor.id)}
                        dragDisabled={dragDisabled}
                        onSelect={toggleSelect}
                        onCheck={(target) => checkNow(target).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '检测失败'))}
                        onVisibility={(target, hidden) => setVisibility(target, hidden).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '设置失败'))}
                        onEnabled={(target, enabled) => setEnabled(target, enabled).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '设置失败'))}
                        onEdit={openEdit}
                        onRemove={setDeleteMonitor}
                      />
                    ))}
                  </Table.Body>
                </Table.Root>
              </div>
            )}
          </SortableContext>
        </DndContext>
        {filtered.length === 0 && <Text align="center" color="gray" style={{ display: 'block', padding: 24 }}>{search ? '未找到匹配的网站' : '暂无网站监控'}</Text>}
      </Card>

      <Dialog.Root open={Boolean(deleteMonitor)} onOpenChange={(open) => { if (!open && !deleting) setDeleteMonitor(null); }}>
        <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 400 }}>
          <Dialog.Title>确认删除</Dialog.Title>
          <Text size="2">确定要删除网站监控 <strong>{deleteMonitor?.name}</strong> 吗？此操作不可撤销。</Text>
          <Flex gap="3" justify="end" mt="4">
            <Button variant="soft" onClick={() => setDeleteMonitor(null)} disabled={deleting}>取消</Button>
            <Button color="red" onClick={() => deleteMonitor && remove(deleteMonitor).catch((error: unknown) => toast.error(error instanceof Error ? error.message : '删除失败'))} disabled={deleting}>
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={editOpen} onOpenChange={setEditOpen}>
        <Dialog.Content
          ref={editDialogRef}
          tabIndex={-1}
          aria-describedby={undefined}
          className="admin-website-edit-dialog"
          style={{ maxWidth: 640 }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => editDialogRef.current?.focus({ preventScroll: true }));
          }}
        >
          <Dialog.Title>{editMonitor ? '编辑监控' : '添加监控'}</Dialog.Title>
          <div className="admin-website-dialog-scroll">
          <Flex direction="column" gap="3">
            <Grid className="admin-website-compact-grid" columns={{ initial: '1', sm: '2' }} gap="3">
              <label>
                <Text size="2" weight="bold">名称</Text>
                <TextField.Root value={form.name} onChange={(event) => update('name', event.target.value)} />
              </label>
              <label>
                <Text size="2" weight="bold">检测方式</Text>
                <Select.Root value={form.method} onValueChange={(value) => updateMethod(value as WebsiteMethod)}>
                  <Select.Trigger style={{ width: '100%' }} />
                  <Select.Content>
                    <Select.Item value="GET">HTTP GET</Select.Item>
                    <Select.Item value="HEAD">HTTP HEAD</Select.Item>
                    <Select.Item value="TCP">TCP 端口</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
            </Grid>
            <label>
              <Text size="2" weight="bold">{form.method === 'TCP' ? '主机或 IP:端口' : '网址'}</Text>
              <TextField.Root
                value={form.url}
                placeholder={form.method === 'TCP' ? 'tcp://example.com:22' : 'https://example.com'}
                onChange={(event) => update('url', event.target.value)}
              />
            </label>
            <Grid className="admin-website-compact-grid" columns={{ initial: '1', sm: '3' }} gap="3">
              <label><Text size="2" weight="bold">检测间隔(秒)</Text><TextField.Root type="number" value={String(form.interval_sec)} onChange={(event) => update('interval_sec', Number(event.target.value))} /></label>
              <label><Text size="2" weight="bold">超时(秒)</Text><TextField.Root type="number" value={String(form.timeout_sec)} onChange={(event) => update('timeout_sec', Number(event.target.value))} /></label>
              <label><Text size="2" weight="bold">宽限期(秒)</Text><TextField.Root type="number" value={String(form.grace_period_sec)} onChange={(event) => update('grace_period_sec', Number(event.target.value))} /></label>
              {form.method !== 'TCP' && (
                <>
                  <label><Text size="2" weight="bold">最小状态码</Text><TextField.Root type="number" value={String(form.expected_status_min)} onChange={(event) => update('expected_status_min', Number(event.target.value))} /></label>
                  <label><Text size="2" weight="bold">最大状态码</Text><TextField.Root type="number" value={String(form.expected_status_max)} onChange={(event) => update('expected_status_max', Number(event.target.value))} /></label>
                </>
              )}
            </Grid>
            <Flex gap="4" wrap="wrap">
              <label className="admin-website-toggle"><Switch checked={form.enabled} onCheckedChange={(value) => update('enabled', value)} />启用检测</label>
              <label className="admin-website-toggle"><Switch checked={form.hidden} onCheckedChange={(value) => update('hidden', value)} />对游客隐藏</label>
            </Flex>
            <Grid className="admin-website-compact-grid" columns={{ initial: '1', sm: '3' }} gap="3">
              <label>
                <Text size="2" weight="bold">Agent 探测</Text>
                <Select.Root value={form.agent_probe_mode} onValueChange={(value) => update('agent_probe_mode', value as WebsiteAgentProbeMode)}>
                  <Select.Trigger style={{ width: '100%' }} />
                  <Select.Content>
                    <Select.Item value="off">关闭</Select.Item>
                    <Select.Item value="selected">指定节点</Select.Item>
                    <Select.Item value="country_auto">按国家自动</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
              <label>
                <Text size="2" weight="bold">节点上限</Text>
                <TextField.Root type="number" min="1" max="10" value={String(form.agent_probe_limit)} onChange={(event) => update('agent_probe_limit', Number(event.target.value))} />
              </label>
              <label className="admin-website-toggle" style={{ alignSelf: 'end' }}>
                <Switch checked={form.agent_probe_status_enabled} onCheckedChange={(value) => update('agent_probe_status_enabled', value)} />CF 兜底
              </label>
            </Grid>
            {form.agent_probe_mode === 'selected' && (
              <Flex gap="2" wrap="wrap">
                {clients.length > 0 ? clients.map((client) => (
                  <label key={client.uuid} className="admin-website-toggle">
                    <Checkbox
                      checked={form.agent_probe_clients.includes(client.uuid)}
                      onCheckedChange={(checked) => toggleAgentProbeClient(client.uuid, checked)}
                    />
                    {client.name || client.uuid}
                  </label>
                )) : (
                  <Text size="2" color="gray">暂无可选节点</Text>
                )}
              </Flex>
            )}
            {editMonitor && <WebsiteHeartbeatBar checks={checks} max={60} />}
            <Flex gap="2" justify="end" wrap="wrap">
              <Flex gap="2">
                <Button variant="soft" color="gray" onClick={() => setEditOpen(false)}>取消</Button>
                <Button onClick={save} disabled={saving}><Save size={16} />{saving ? '保存中' : '保存'}</Button>
              </Flex>
            </Flex>
          </Flex>
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
