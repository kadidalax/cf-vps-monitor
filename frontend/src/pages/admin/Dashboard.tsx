import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Flex, Card, Text, Badge, Box, Button, TextField,
  Dialog, Switch, IconButton, Separator, TextArea, SegmentedControl, Checkbox, Tooltip, Select
} from '@radix-ui/themes';
import {
  Plus, Pencil, Trash2, Copy, Search,
  GripVertical, RefreshCw, Download, EyeOff, Server, Wifi, Layers, KeyRound
} from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { useLiveData } from '../../contexts/LiveDataContext';
import Flag from '../../components/Flag';
import PriceTags from '../../components/PriceTags';
import { BillingCycleSelect, CurrencySymbols, ExpiryDateInput } from '../../components/admin/BillingControls';
import { TrafficLimitEditor } from '../../components/admin/TrafficLimitEditor';
import { formatBytes } from '../../utils/format';
import { isValidDisplayPrice, toDateInputValue } from '../../utils/billing';
import {
  createTrafficLimitFormValue,
  serializeTrafficLimitFormValue,
  TrafficLimitFormValue,
} from '../../utils/traffic';
import { ClientInfo, LiveDataMap } from '../../types';
import {
  AgentInstallOptions,
  AgentInstallPlatform,
  buildAgentInstallCommand,
  buildAgentUninstallAllCommand,
  defaultAgentInstallOptions,
  normalizeServerUrl,
} from '../../utils/agentInstallCommand';
import {
  AdminSortKey,
  getNodeGroups,
  NodeStatusFilter,
  normalizeLiveData,
  sortAdminNodes,
} from '../../utils/monitorView';
import { fetchPublicSettings } from '../../utils/publicSettings';
import { notifyPublicDataUpdated, subscribePublicDataUpdated } from '../../utils/publicDataEvents';
import type { PublicDataUpdateDetail } from '../../utils/publicDataEvents';
import { moveAdminNodeInVisibleOrder } from '../../utils/adminNodeOrder';

interface AdminClient extends ClientInfo {
  token?: string;
  token_last_used_at?: string | null;
  token_last_used_ip?: string;
  token_rotated_at?: string | null;
  remark: string;
  public_remark: string;
  version: string;
  virtualization: string;
  kernel_version: string;
  cpu_name: string;
  gpu_name: string;
  created_at: string;
  updated_at: string;
  auto_renewal: boolean;
  traffic_limit_type: string;
}

type CommandClient = Partial<AdminClient> & Pick<AdminClient, 'uuid' | 'name'> & { token?: string };

function optimisticAdminClient(created: CommandClient): AdminClient {
  const now = new Date().toISOString();
  const { uuid, name, token, ...rest } = created;
  return {
    uuid,
    name,
    cpu_name: '',
    cpu_cores: 0,
    os: '',
    arch: '',
    region: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    group: '',
    tags: '',
    hidden: false,
    price: 0,
    billing_cycle: 0,
    currency: '$',
    expired_at: '',
    traffic_limit: 0,
    traffic_limit_type: 'max',
    sort_order: 0,
    token,
    token_last_used_at: null,
    token_last_used_ip: '',
    token_rotated_at: null,
    remark: '',
    public_remark: '',
    version: '',
    virtualization: '',
    kernel_version: '',
    gpu_name: '',
    created_at: now,
    updated_at: now,
    auto_renewal: false,
    ...rest,
  };
}

function applyAdminClientUpdate(current: AdminClient[], detail?: PublicDataUpdateDetail): AdminClient[] {
  const clientDelta = detail?.clients;
  if (!clientDelta) return current;
  const remove = new Set(clientDelta.remove || []);
  const upserts = (clientDelta.upsert || [])
    .filter((client): client is Partial<AdminClient> & { uuid: string } =>
      Boolean(client && typeof client === 'object' && typeof (client as { uuid?: unknown }).uuid === 'string'),
    );
  const byUuid = new Map(
    current
      .filter((client) => !remove.has(client.uuid))
      .map((client) => [client.uuid, client]),
  );
  for (const client of upserts) {
    const existing = byUuid.get(client.uuid);
    if (existing) byUuid.set(client.uuid, { ...existing, ...client });
    else byUuid.set(client.uuid, {
      ...optimisticAdminClient({ uuid: client.uuid, name: client.name || client.uuid }),
      ...client,
    });
  }
  return [...byUuid.values()];
}

interface SortableRowProps {
  node: AdminClient;
  selected: boolean;
  onSelect: (uuid: string) => void;
  liveData: LiveDataMap;
  onDetail: (client: AdminClient) => void;
  onEdit: (client: AdminClient) => void;
  onDelete: (client: AdminClient) => void;
  onCmd: (client: CommandClient) => void;
  onRotateToken: (client: AdminClient) => void;
  dragDisabled?: boolean;
}

async function copyToClipboard(text: string, message = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    toast.error('复制失败，请手动复制');
  }
}

function CopyableIp({ value, muted }: { value: string; muted?: boolean }) {
  const family = value.includes(':') ? 'v6' : 'v4';
  return (
    <Flex align="center" gap="1" className={`admin-ip-line admin-ip-${family}`}>
      <Text
        size="1"
        color={muted ? 'gray' : undefined}
        title={value}
        className="admin-ip-value"
        style={{ fontFamily: 'monospace' }}
      >
        {value}
      </Text>
      <Tooltip content="复制 IP">
        <IconButton
          aria-label="复制 IP"
          className="admin-ip-copy"
          size="1"
          variant="ghost"
          onClick={() => copyToClipboard(value, 'IP 已复制')}
        >
          <Copy size={12} />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function RowActionButton({
  label,
  color,
  onClick,
  children,
}: {
  label: string;
  color?: 'red';
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <IconButton
        aria-label={label}
        className={`admin-row-action${color === 'red' ? ' admin-row-action-danger' : ''}`}
        size="2"
        variant="soft"
        color={color}
        onClick={onClick}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

function normalizeAgentVersion(version?: string) {
  const value = version?.trim();
  if (!value) return '';
  const semver = value.match(/v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?/i)?.[0];
  if (semver) return /^v/i.test(semver) ? semver : `v${semver}`;
  if (/^v/i.test(value) || !/^\d/.test(value)) return value;
  return `v${value}`;
}

function compactOsLabel(os?: string) {
  const value = os?.trim();
  if (!value) return '';

  const lower = value.toLowerCase();
  const distroMap: Array<[RegExp, string]> = [
    [/debian/, 'debian'],
    [/ubuntu/, 'ubuntu'],
    [/centos/, 'centos'],
    [/rocky/, 'rocky'],
    [/alma/, 'alma'],
    [/fedora/, 'fedora'],
    [/alpine/, 'alpine'],
    [/openwrt/, 'openwrt'],
    [/open\s*suse|opensuse/, 'opensuse'],
    [/freebsd/, 'freebsd'],
    [/windows/, 'windows'],
    [/arch/, 'arch'],
  ];
  const distro = distroMap.find(([pattern]) => pattern.test(lower))?.[1] || lower.split(/\s+/)[0];
  const versionMatch = lower.match(/\b\d{1,3}(?:\.\d{1,2})?\b/);

  return `${distro}${versionMatch?.[0] || ''}`;
}

function formatSystemVersion(node: AdminClient) {
  const os = compactOsLabel(node.os) || node.os?.trim() || '';
  const arch = node.arch?.trim();
  return [os, arch].filter(Boolean).join(' / ') || '-';
}

function formatDetailTime(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

function SortableNodeCard({ node, selected, onSelect, liveData, onDetail, onEdit, onDelete, onCmd, onRotateToken, dragDisabled }: SortableRowProps) {
  const isOnline = liveData.online.includes(node.uuid);
  const agentVersion = normalizeAgentVersion(node.version) || '-';
  const systemVersion = formatSystemVersion(node);
  const fullVersionTitle = [
    `客户端版本: ${node.version || '-'}`,
    `系统版本: ${[node.os, node.arch].filter(Boolean).join(' / ') || '-'}`,
  ].join('\n');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: node.uuid,
    disabled: dragDisabled,
  });

  const cardStyle = {
    opacity: isDragging ? 0.72 : isOnline ? 1 : 0.55,
    transform: CSS.Transform.toString(transform),
    transition,
    position: 'relative',
    zIndex: isDragging ? 2 : 0,
  } as React.CSSProperties;

  return (
    <div ref={setNodeRef} className={`admin-node-card-shell${isDragging ? ' is-dragging' : ''}`} style={cardStyle}>
      <Card className={`admin-node-card${selected ? ' is-selected' : ''}${isOnline ? ' is-online' : ' is-offline'}`}>
        <div className="admin-node-card-header">
          <div className="admin-node-card-controls">
            <Tooltip content={dragDisabled ? '切到手动排序后可拖拽' : '拖拽排序'}>
              <button
                type="button"
                className="admin-row-drag-handle"
                aria-label={`拖拽排序 ${node.name || node.uuid}`}
                disabled={dragDisabled}
                {...attributes}
                {...listeners}
              >
                <GripVertical size={15} />
              </button>
            </Tooltip>
            <Checkbox className="admin-node-checkbox" checked={selected} onCheckedChange={() => onSelect(node.uuid)} />
          </div>

          <button
            type="button"
            className="admin-node-card-title"
            onClick={() => onDetail(node)}
            title={node.name || '查看详情'}
          >
            <span className="admin-node-card-title-copy">
              <span className="admin-node-card-name-row">
                <span className="admin-node-card-flag">
                  <Flag region={node.region} size={20} />
                </span>
                <Text className="admin-node-name-text" size="2" weight="bold">{node.name || '未命名'}</Text>
              </span>
              <span className="admin-node-card-badges">
                <Badge size="1" variant="soft" color={isOnline ? 'green' : 'gray'}>{isOnline ? '在线' : '离线'}</Badge>
                <Badge className="admin-node-region-badge" size="1" variant="soft" color="gray" title={node.region || '未知'}>{node.region || '未知'}</Badge>
                {Boolean(node.hidden) && <Badge size="1" variant="soft" color="orange">隐藏</Badge>}
              </span>
            </span>
          </button>

          <Flex className="admin-row-actions">
            <RowActionButton label="编辑" onClick={() => onEdit(node)}><Pencil size={13} /></RowActionButton>
            <RowActionButton label="安装命令" onClick={() => onCmd(node)}><Download size={13} /></RowActionButton>
            <RowActionButton label="重置 Token" onClick={() => onRotateToken(node)}><KeyRound size={13} /></RowActionButton>
            <RowActionButton label="删除" color="red" onClick={() => onDelete(node)}><Trash2 size={13} /></RowActionButton>
          </Flex>
        </div>

        <div className="admin-node-card-body">
          <div className="admin-node-card-ip-panel">
            <Text className="admin-node-card-section-label" size="1" weight="bold">IP 地址</Text>
            <div className="admin-node-ip-stack">
              {node.ipv4 && <CopyableIp value={node.ipv4} />}
              {node.ipv6 && <CopyableIp value={node.ipv6} muted />}
              {!node.ipv4 && !node.ipv6 && <Text size="1" color="gray">-</Text>}
            </div>
          </div>

          <div className="admin-node-card-meta-grid">
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">Agent</Text>
              <Text className="admin-node-version-text" size="1" title={fullVersionTitle}>{agentVersion}</Text>
            </div>
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">系统</Text>
              <Text className="admin-node-version-os" size="1" color="gray" title={fullVersionTitle}>{systemVersion}</Text>
            </div>
            <div className="admin-node-card-meta">
              <Text className="admin-node-card-section-label" size="1" weight="bold">分组</Text>
              <Text className="admin-node-group-text" size="1" title={node.group}>{node.group || '-'}</Text>
            </div>
            <div className="admin-node-card-meta admin-node-card-billing">
              <Text className="admin-node-card-section-label" size="1" weight="bold">账单</Text>
              <PriceTags price={node.price} billing_cycle={node.billing_cycle} expired_at={node.expired_at} currency={node.currency} showTags={false} />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function GenerateCommandDialog({ client, open, onOpenChange }: { client: CommandClient; open: boolean; onOpenChange: (v: boolean) => void }) {
  const apiFetch = useApi();
  const [platform, setPlatform] = useState<AgentInstallPlatform>('unix');
  const [serverUrl, setServerUrl] = useState('');
  const [installOptions, setInstallOptions] = useState<AgentInstallOptions>(defaultAgentInstallOptions);
  const [agentToken, setAgentToken] = useState('');
  const [loadingToken, setLoadingToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (open) {
      setInstallOptions({ ...defaultAgentInstallOptions });
      setAgentToken(client.token || '');
      fetchPublicSettings()
        .then(d => {
          if (!cancelled) setServerUrl(d.script_domain || window.location.origin);
        })
        .catch(() => {
          if (!cancelled) setServerUrl(window.location.origin);
        });
    }
    return () => { cancelled = true; };
  }, [client.token, open]);

  useEffect(() => {
    if (!open) return;
    if (client.token) {
      setLoadingToken(false);
      return;
    }
    let cancelled = false;
    setLoadingToken(true);
    (async () => {
      try {
        const result = await apiFetch('/admin/clients/' + client.uuid + '/token/install', { method: 'POST' });
        if (cancelled) return;
        if (typeof result.token === 'string' && result.token) {
          setAgentToken(result.token);
        } else {
          toast.error(result.error || '获取 Token 失败');
          onOpenChange(false);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : '获取 Token 失败');
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) setLoadingToken(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, client.token, client.uuid, onOpenChange, open]);

  const setOption = <K extends keyof AgentInstallOptions>(key: K, value: AgentInstallOptions[K]) => {
    setInstallOptions(prev => ({ ...prev, [key]: value }));
  };

  const normalizedServerUrl = useMemo(() => {
    return normalizeServerUrl(serverUrl, window.location.origin);
  }, [serverUrl]);

  const cmd = buildAgentInstallCommand({
      platform,
      serverUrl: normalizedServerUrl,
      token: agentToken,
      options: installOptions,
      instanceId: client.uuid,
      nodeName: client.name,
    });
  const uninstallAllCmd = buildAgentUninstallAllCommand({
      platform,
      serverUrl: normalizedServerUrl,
      ghproxy: installOptions.ghproxy,
      scriptRef: installOptions.scriptRef,
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="admin-command-dialog" style={{ maxWidth: 680 }}>
        <Dialog.Title>生成 CF VPS Monitor Agent 安装命令</Dialog.Title>
        <Dialog.Description size="2" mb="2">节点: {client.name}</Dialog.Description>
        <SegmentedControl.Root value={platform} onValueChange={(v) => setPlatform(v as AgentInstallPlatform)} style={{ marginBottom: 12 }}>
          <SegmentedControl.Item value="unix">Unix 自动检测</SegmentedControl.Item>
          <SegmentedControl.Item value="windows">Windows</SegmentedControl.Item>
        </SegmentedControl.Root>

        <Flex className="admin-command-options-scroll" direction="column" gap="3">
          <FieldInput label="连接地址" value={serverUrl} onChange={setServerUrl} placeholder={window.location.origin} />
          <Text size="2" weight="bold">安装选项</Text>
          <div className="install-options-grid">
            <label>
              <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>安装模式</Text>
              <Select.Root value={installOptions.installMode} onValueChange={(v) => setOption('installMode', v as AgentInstallOptions['installMode'])}>
                <Select.Trigger style={{ width: '100%' }} />
                <Select.Content>
                  <Select.Item value="auto">自动选择</Select.Item>
                  <Select.Item value="system">系统服务</Select.Item>
                  <Select.Item value="user">用户模式</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
            <FieldInput label="GitHub 代理" value={installOptions.ghproxy} onChange={(v) => setOption('ghproxy', v)} placeholder="为空则不使用代理" />
            <FieldInput label="下载代理" value={installOptions.downloadProxy} onChange={(v) => setOption('downloadProxy', v)} placeholder="例如 http://127.0.0.1:10808" />
            <FieldInput label="安装目录" value={installOptions.dir} onChange={(v) => setOption('dir', v)} placeholder={platform === 'windows' ? 'C:\\Program Files\\CF VPS Monitor' : '自动选择系统目录或用户目录'} />
            <FieldInput label="服务名称" value={installOptions.serviceName} onChange={(v) => setOption('serviceName', v)} placeholder={platform === 'windows' ? 'CFVpsMonitorAgent' : 'cf-vps-monitor-agent'} />
            <FieldInput label="二进制下载地址" value={installOptions.binaryUrl || ''} onChange={(v) => setOption('binaryUrl', v)} placeholder="为空则自动下载预编译二进制" />
            <FieldInput label="SHA256SUMS 地址" value={installOptions.checksumUrl || ''} onChange={(v) => setOption('checksumUrl', v)} placeholder="自定义二进制地址必须填写" />
            <FieldInput label="Release Tag" value={installOptions.releaseTag || ''} onChange={(v) => setOption('releaseTag', v)} placeholder="为空则使用最新发布版" />
            <FieldInput label="磁盘包含" value={installOptions.mountInclude} onChange={(v) => setOption('mountInclude', v)} placeholder="例如 /,/data,/dev/sd*" />
            <FieldInput label="磁盘排除" value={installOptions.mountExclude} onChange={(v) => setOption('mountExclude', v)} placeholder="例如 /boot,tmpfs,/run" />
            <FieldInput label="网卡包含" value={installOptions.nicInclude} onChange={(v) => setOption('nicInclude', v)} placeholder="例如 eth*,ens*" />
            <FieldInput label="网卡排除" value={installOptions.nicExclude} onChange={(v) => setOption('nicExclude', v)} placeholder="例如 lo,docker*,veth*" />
            <FieldInput label="流量重置日期" value={installOptions.trafficResetDay} onChange={(v) => setOption('trafficResetDay', v)} type="number" min={1} step={1} placeholder="1" />
          </div>
        </Flex>

        <Box className="admin-command-code">{loadingToken ? '正在获取 Token...' : cmd}</Box>
        <Flex justify="end" gap="2" mt="3">
          <Button color="red" variant="soft" onClick={() => copyToClipboard(uninstallAllCmd, '彻底卸载命令已复制')}>
            <Trash2 size={14} /> 彻底卸载
          </Button>
          <Button variant="soft" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button onClick={() => copyToClipboard(cmd, '命令已复制')} disabled={loadingToken || !agentToken}><Copy size={14} /> 复制命令</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function DetailDialog({ client, open, onOpenChange }: { client: AdminClient; open: boolean; onOpenChange: (v: boolean) => void }) {
  const fields: [string, string][] = [
    ['UUID', client.uuid], ['名称', client.name], ['IPv4', client.ipv4 || '-'], ['IPv6', client.ipv6 || '-'],
    ['操作系统', client.os || '-'], ['架构', client.arch || '-'], ['内核', client.kernel_version || '-'],
    ['虚拟化', client.virtualization || '-'], ['CPU', client.cpu_name || '-'], ['CPU核心', String(client.cpu_cores || '-')],
    ['GPU', client.gpu_name || '-'], ['总内存', formatBytes(client.mem_total)], ['总磁盘', formatBytes(client.disk_total)],
    ['总Swap', formatBytes(client.swap_total)], ['区域', client.region || '-'], ['分组', client.group || '-'],
    ['标签', client.tags || '-'], ['客户端版本', client.version || '-'],
    ['Token 最近使用', formatDetailTime(client.token_last_used_at)],
    ['Token 最近使用 IP', client.token_last_used_ip || '-'],
    ['Token 轮换时间', formatDetailTime(client.token_rotated_at)],
    ['创建时间', formatDetailTime(client.created_at)],
    ['更新时间', formatDetailTime(client.updated_at)],
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="admin-node-dialog" style={{ maxWidth: 600 }}>
        <Dialog.Title>机器详细信息</Dialog.Title>
        <Dialog.Description size="2" mb="3">{client.name}</Dialog.Description>
        <Flex className="admin-node-detail-list" direction="column" gap="1">
          {fields.map(([label, value]) => (
            <div key={label} className="admin-node-detail-row">
              <Text className="admin-node-detail-label" size="2" color="gray">{label}</Text>
              {label === 'IPv4' && client.ipv4 ? (
                <CopyableIp value={client.ipv4} />
              ) : label === 'IPv6' && client.ipv6 ? (
                <CopyableIp value={client.ipv6} muted />
              ) : (
                <Text className="admin-node-detail-value" size="2">{value}</Text>
              )}
            </div>
          ))}
        </Flex>
        <Flex justify="end" mt="3"><Button onClick={() => onOpenChange(false)}>完成</Button></Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  textarea,
  type,
  placeholder,
  helper,
  min,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  type?: string;
  placeholder?: string;
  helper?: string;
  min?: string | number;
  step?: string | number;
}) {
  return (
    <label>
      <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>{label}</Text>
      {textarea
        ? <TextArea style={{ width: '100%' }} value={value} onChange={e => onChange(e.target.value)} rows={2} placeholder={placeholder} />
        : (
          <TextField.Root
            style={{ width: '100%' }}
            value={value}
            onChange={e => onChange(e.target.value)}
            type={(type || 'text') as never}
            placeholder={placeholder}
            min={min as never}
            step={step as never}
          />
        )
      }
      {helper && <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>{helper}</Text>}
    </label>
  );
}

function EditDialog({ client, open, onOpenChange, onSaved }: { client: AdminClient | null; open: boolean; onOpenChange: (v: boolean) => void; onSaved: (uuid: string, patch: Partial<AdminClient>, saved?: Partial<AdminClient> & { uuid: string }) => void }) {
  const apiFetch = useApi();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (client) setForm({
      name: client.name || '', remark: client.remark || '', public_remark: client.public_remark || '',
      group: client.group || '', tags: client.tags || '',
      price: client.price ?? 0, currency: client.currency || '¥', billing_cycle: client.billing_cycle || 30,
      traffic_limit_form: createTrafficLimitFormValue(client.traffic_limit, client.traffic_limit_type),
      expired_at: toDateInputValue(client.expired_at),
      hidden: client.hidden || false, auto_renewal: client.auto_renewal || false,
    });
  }, [client]);

  const update = (key: string, val: unknown) => setForm(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    if (!client) return;
    setSaving(true);
    try {
      const payload = { ...form } as Record<string, unknown>;
      const price = Number(payload.price ?? 0);
      if (!isValidDisplayPrice(price)) {
        toast.error('价格无效：0 不显示，-1 表示免费');
        return;
      }
      payload.price = price;
      const billingCycle = parseInt(String(payload.billing_cycle || 30), 10);
      payload.billing_cycle = Number.isFinite(billingCycle) ? billingCycle : 30;
      payload.currency = String(payload.currency || '¥');
      const trafficLimit = serializeTrafficLimitFormValue(payload.traffic_limit_form as TrafficLimitFormValue);
      payload.traffic_limit = trafficLimit.traffic_limit;
      payload.traffic_limit_type = trafficLimit.traffic_limit_type;
      delete payload.traffic_limit_form;
      if (payload.expired_at === '') payload.expired_at = null;
      const result = await apiFetch('/admin/clients/' + client.uuid + '/edit', { method: 'POST', body: JSON.stringify(payload) });
      if (result.success || result.uuid) {
        const saved = result.client && typeof result.client === 'object' && typeof result.client.uuid === 'string'
          ? result.client as Partial<AdminClient> & { uuid: string }
          : undefined;
        toast.success('保存成功');
        onOpenChange(false);
        onSaved(client.uuid, payload as Partial<AdminClient>, saved);
      }
      else toast.error(result.error || '保存失败');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} className="admin-node-dialog admin-node-edit-dialog" style={{ maxWidth: 640 }}>
        <Dialog.Title>编辑服务器</Dialog.Title>
        <div className="admin-node-dialog-scroll">
          <Flex className="admin-node-edit-form" direction="column" gap="3">
            <FieldInput label="名称" value={String(form.name || '')} onChange={v => update('name', v)} />
            <FieldInput label="私有备注" value={String(form.remark || '')} onChange={v => update('remark', v)} textarea />
            <FieldInput label="公开备注" value={String(form.public_remark || '')} onChange={v => update('public_remark', v)} textarea />
            <FieldInput label="分组" value={String(form.group || '')} onChange={v => update('group', v)} />
            <FieldInput label="标签 (分号分隔)" value={String(form.tags || '')} onChange={v => update('tags', v)} />
            <Separator size="4" />
            <Text size="2" weight="bold">计费信息</Text>
            <div className="billing-price-grid">
              <Box>
                <FieldInput
                  label="价格"
                  value={String(form.price ?? 0)}
                  onChange={v => update('price', v)}
                  type="number"
                  min="-1"
                  step="0.01"
                />
              </Box>
              <Box>
                <FieldInput label="货币" value={String(form.currency || '¥')} onChange={v => update('currency', v)} />
              </Box>
              <Text className="billing-price-helper" size="1" color="gray">
                0 不显示，-1 表示免费
              </Text>
            </div>
            <CurrencySymbols onPick={(symbol) => update('currency', symbol)} />
            <div className="billing-schedule-grid">
              <Box>
                <BillingCycleSelect value={form.billing_cycle as number | string | undefined} onChange={v => update('billing_cycle', v)} />
              </Box>
              <Box>
                <ExpiryDateInput value={String(form.expired_at || '')} onChange={v => update('expired_at', v)} />
              </Box>
            </div>
            <TrafficLimitEditor
              value={(form.traffic_limit_form as TrafficLimitFormValue) || createTrafficLimitFormValue(0, 'sum')}
              onChange={(value) => update('traffic_limit_form', value)}
            />
            <Flex className="billing-switch-row" gap="3">
              <Flex className="billing-switch-item" align="center" justify="between">
                <Text size="2">对游客隐藏</Text>
                <Switch checked={Boolean(form.hidden)} onCheckedChange={v => update('hidden', v)} />
              </Flex>
              <Flex className="billing-switch-item" align="center" justify="between">
                <Text size="2">自动续费</Text>
                <Switch checked={Boolean(form.auto_renewal)} onCheckedChange={v => update('auto_renewal', v)} />
              </Flex>
            </Flex>
          </Flex>
        </div>
        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function AddDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; onSaved: (created?: CommandClient) => void }) {
  const apiFetch = useApi();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAdd = async () => {
    setLoading(true);
    try {
      const result = await apiFetch('/admin/clients/add', { method: 'POST', body: JSON.stringify({ name }) });
      if (result.success || result.uuid) {
        toast.success('添加成功');
        const apiClient = result.client && typeof result.client === 'object' && typeof result.client.uuid === 'string'
          ? result.client as Partial<AdminClient> & { uuid: string; name?: string }
          : null;
        const created = apiClient
          ? {
              ...apiClient,
              name: apiClient.name || name.trim() || '未命名服务器',
              token: typeof result.token === 'string' ? result.token : undefined,
            }
          : typeof result.uuid === 'string'
            ? { uuid: result.uuid, name: name.trim() || '未命名服务器', token: typeof result.token === 'string' ? result.token : undefined }
          : undefined;
        setName('');
        onOpenChange(false);
        onSaved(created);
      }
      else toast.error(result.error || '添加失败');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '添加失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 420 }}>
        <Dialog.Title>添加服务器</Dialog.Title>
        <Flex direction="column" gap="3" mt="2">
          <FieldInput label="服务器名称" value={name} onChange={setName} placeholder="可选，创建后可修改" />
          <Text size="1" color="gray">创建后将生成 Token，用于 Agent 连接</Text>
        </Flex>
        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleAdd} disabled={loading}>{loading ? '创建中...' : '创建'}</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function DeleteDialog({ client, open, onOpenChange, onDeleted }: { client: AdminClient | null; open: boolean; onOpenChange: (v: boolean) => void; onDeleted: (uuid: string) => void }) {
  const apiFetch = useApi();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!client) return;
    setDeleting(true);
    try {
      const result = await apiFetch('/admin/clients/' + client.uuid + '/remove', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.success) { toast.success('已删除 ' + client.name); onOpenChange(false); onDeleted(client.uuid); }
      else toast.error(result.error || '删除失败');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 400 }}>
        <Dialog.Title>确认删除</Dialog.Title>
        <Text size="2">确定要删除服务器 <strong>{client?.name}</strong> 吗？此操作不可撤销。</Text>
        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button color="red" onClick={handleDelete} disabled={deleting}>{deleting ? '删除中...' : '确认删除'}</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function RotateTokenDialog({ client, open, onOpenChange, onRotated }: { client: AdminClient | null; open: boolean; onOpenChange: (v: boolean) => void; onRotated: (token?: string) => void }) {
  const apiFetch = useApi();
  const [rotating, setRotating] = useState(false);

  const handleRotate = async () => {
    if (!client) return;
    setRotating(true);
    try {
      const result = await apiFetch('/admin/clients/' + client.uuid + '/token/rotate', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.success) {
        toast.success('Token 已重置，请重新复制安装命令');
        onOpenChange(false);
        onRotated(typeof result.token === 'string' ? result.token : undefined);
      } else {
        toast.error(result.error || '重置 Token 失败');
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '重置 Token 失败');
    } finally {
      setRotating(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 420 }}>
        <Dialog.Title>重置 Agent Token</Dialog.Title>
        <Flex direction="column" gap="2">
          <Text size="2">确定要重置 <strong>{client?.name}</strong> 的 Agent Token 吗？</Text>
          <Text size="2" color="gray">旧 Agent 会立刻无法继续上报，需要用新的安装命令或配置重新启动。</Text>
        </Flex>
        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button color="red" onClick={handleRotate} disabled={rotating}>{rotating ? '重置中...' : '确认重置'}</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export default function AdminDashboard() {
  const apiFetch = useApi();
  const { liveData: rawLiveData, refresh: refreshLive } = useLiveData();
  const [clients, setClients] = useState<AdminClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [statusFilter, setStatusFilter] = useState<NodeStatusFilter>('all');
  const [sortKey, setSortKey] = useState<AdminSortKey>('manual');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [addOpen, setAddOpen] = useState(false);
  const [editClient, setEditClient] = useState<AdminClient | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteClient, setDeleteClient] = useState<AdminClient | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rotateTokenClient, setRotateTokenClient] = useState<AdminClient | null>(null);
  const [rotateTokenOpen, setRotateTokenOpen] = useState(false);
  const [detailClient, setDetailClient] = useState<AdminClient | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [cmdClient, setCmdClient] = useState<CommandClient | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);

  const liveData: LiveDataMap = useMemo(() => normalizeLiveData(rawLiveData), [rawLiveData]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 批量选择
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  const toggleSelect = (uuid: string) => {
    setSelectedNodes(prev => prev.includes(uuid) ? prev.filter(id => id !== uuid) : [...prev, uuid]);
  };

  const toggleSelectAll = () => {
    const filteredUuids = filtered.map(c => c.uuid);
    const filteredSet = new Set(filteredUuids);
    setSelectedNodes(prev => {
      const allVisibleSelected = filteredUuids.length > 0 && filteredUuids.every((uuid) => prev.includes(uuid));
      if (allVisibleSelected) return prev.filter((uuid) => !filteredSet.has(uuid));
      return Array.from(new Set([...prev, ...filteredUuids]));
    });
  };

  const batchHideNodes = async () => {
    try {
      const result = await apiFetch('/admin/clients/batch-hide', {
        method: 'POST',
        body: JSON.stringify({ uuids: selectedNodes }),
      });
      if (!result.success) throw new Error(result.error || '批量隐藏失败');
      toast.success(`已隐藏 ${result.updated ?? selectedNodes.length} 个节点`);
      setClients((prev) => prev.map((client) => selectedNodes.includes(client.uuid) ? { ...client, hidden: true } : client));
      setSelectedNodes([]);
      notifyPublicDataUpdated({
        clients: {
          upsert: clients.filter((client) => selectedNodes.includes(client.uuid)).map((client) => ({ ...client, hidden: true })),
          remove: selectedNodes,
        },
      });
    } catch (error) { toast.error(error instanceof Error ? error.message : '批量隐藏失败'); }
  };

  const batchDeleteNodes = async () => {
    try {
      const result = await apiFetch('/admin/clients/batch-remove', {
        method: 'POST',
        body: JSON.stringify({ uuids: selectedNodes }),
      });
      if (!result.success) throw new Error(result.error || '批量删除失败');
      toast.success(`已删除 ${result.removed ?? selectedNodes.length} 个节点`);
      setClients((prev) => prev.filter((client) => !selectedNodes.includes(client.uuid)));
      setSelectedNodes([]);
      setBatchDeleteOpen(false);
      notifyPublicDataUpdated({ clients: { remove: selectedNodes } });
    } catch (error) { toast.error(error instanceof Error ? error.message : '批量删除失败'); }
  };

  const sortedClients = useMemo(() => {
    return sortAdminNodes(clients, liveData, {
      searchTerm: search,
      selectedGroup,
      statusFilter,
      sortKey,
      sortDir,
    }) as AdminClient[];
  }, [clients, liveData, search, selectedGroup, statusFilter, sortKey, sortDir]);

  const filtered = useMemo(() => sortedClients, [sortedClients]);
  const filteredUuids = useMemo(() => filtered.map((client) => client.uuid), [filtered]);
  const dragDisabled = sortKey !== 'manual' || Boolean(search.trim()) || selectedGroup !== 'all' || statusFilter !== 'all';

  const loadClients = useCallback(async (force = false) => {
    try {
      const data = await apiFetch(force ? '/admin/clients?refresh=1' : '/admin/clients');
      if (Array.isArray(data)) setClients(data);
    } catch {}
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { loadClients(); }, [loadClients]);
  useEffect(() => {
    const handleVisible = () => {
      void loadClients();
    };
    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', handleVisible);
    const unsubscribePublicData = subscribePublicDataUpdated((detail) => {
      if (detail?.clients) {
        setClients((current) => applyAdminClientUpdate(current, detail));
        return;
      }
      void loadClients(true);
    });
    const iv = window.setInterval(() => {
      void loadClients();
    }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', handleVisible);
      unsubscribePublicData();
      window.clearInterval(iv);
    };
  }, [loadClients]);

  const groups = useMemo(() => getNodeGroups(clients), [clients]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || dragDisabled) return;

    const previousClients = clients;
    const nextClients = moveAdminNodeInVisibleOrder(clients, filtered, String(active.id), String(over.id));
    if (nextClients === clients) return;
    setClients(nextClients);

    try {
      const result = await apiFetch('/admin/clients/reorder', {
        method: 'POST',
        body: JSON.stringify({ uuids: nextClients.map((client) => client.uuid) }),
      });
      if (result.success) {
        toast.success('节点排序已更新');
        notifyPublicDataUpdated({ clients: { upsert: nextClients } });
      } else {
        toast.error(result.error || '排序失败');
        setClients(previousClients);
        loadClients(true);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '排序失败');
      setClients(previousClients);
      loadClients(true);
    }
  };

  const selectedVisibleCount = useMemo(() => {
    const visible = new Set(filtered.map((client) => client.uuid));
    return selectedNodes.filter((uuid) => visible.has(uuid)).length;
  }, [filtered, selectedNodes]);

  const allFilteredSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;
  const overviewCards = useMemo(() => {
    const onlineCount = clients.filter((client) => liveData.online.includes(client.uuid)).length;
    const hiddenCount = clients.filter((client) => client.hidden).length;

    return [
      {
        label: '服务器总数',
        value: String(clients.length),
        detail: `${filtered.length} 个当前结果`,
        icon: <Server size={18} />,
      },
      {
        label: '在线节点',
        value: `${onlineCount} / ${clients.length}`,
        detail: '来自实时上报状态',
        icon: <Wifi size={18} />,
      },
      {
        label: '节点分组',
        value: String(groups.length),
        detail: groups.length ? groups.slice(0, 3).join(' / ') : '暂无分组',
        icon: <Layers size={18} />,
      },
      {
        label: '对游客隐藏',
        value: String(hiddenCount),
        detail: '不会出现在游客前台',
        icon: <EyeOff size={18} />,
      },
    ];
  }, [clients, filtered.length, groups, liveData.online]);

  if (loading) return <Loading />;

  return (
    <Flex className="admin-dashboard-page" direction="column" gap="3">
      <Flex className="admin-parent-title-row admin-server-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Server size={20} />
          <Text size="5" weight="bold">服务器</Text>
        </Flex>
        <section className="admin-page-hero admin-server-overview-hero">
          <div className="admin-overview-strip">
            {overviewCards.map((card) => (
              <div className="admin-overview-item" key={card.label} title={card.detail}>
                <Flex align="center" gap="2" className="admin-overview-line">
                  <span className="admin-overview-icon" aria-hidden="true">{card.icon}</span>
                  <Text className="admin-overview-label" size="2">{card.label}</Text>
                  <Text className="admin-overview-value" size="4" weight="bold">{card.value}</Text>
                </Flex>
              </div>
            ))}
          </div>
        </section>
      </Flex>

      <Card className="admin-filter-card">
        <Flex className="admin-filter-toolbar" direction="column" gap="2">
          <Flex className="admin-filter-primary-row" gap="2" align="center">
            <Box className="admin-status-filter">
              <SegmentedControl.Root value={statusFilter} onValueChange={(value) => setStatusFilter(value as NodeStatusFilter)} size="1">
                <SegmentedControl.Item value="all">全部</SegmentedControl.Item>
                <SegmentedControl.Item value="online">在线</SegmentedControl.Item>
                <SegmentedControl.Item value="offline">离线</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Box>

            <Flex className="admin-search-cluster" gap="2" align="center">
              <TextField.Root className="admin-server-search" size="1" placeholder="查找服务器" value={search} onChange={e => setSearch(e.target.value)}>
                <TextField.Slot><Search size={14} /></TextField.Slot>
              </TextField.Root>
              <IconButton className="admin-refresh-button" variant="soft" size="1" onClick={() => { loadClients(true); refreshLive(); }} title="刷新"><RefreshCw size={14} /></IconButton>
            </Flex>

            {selectedNodes.length > 0 && (
              <Flex className="admin-selection-inline" gap="2" align="center">
                <Badge variant="soft" color="blue">已选 {selectedNodes.length}</Badge>
                {selectedVisibleCount !== selectedNodes.length && (
                  <Text size="1" color="gray">当前结果 {selectedVisibleCount}</Text>
                )}
                <Button variant="soft" size="1" color="red" onClick={() => setBatchDeleteOpen(true)}>
                  <Trash2 size={14} /> 删除
                </Button>
                <Button variant="soft" size="1" onClick={batchHideNodes}>
                  <EyeOff size={14} /> 隐藏
                </Button>
                <Button variant="ghost" size="1" onClick={() => setSelectedNodes([])}>清除</Button>
              </Flex>
            )}

            <Select.Root value={selectedGroup} onValueChange={setSelectedGroup}>
              <Select.Trigger className="admin-filter-group-select" aria-label="分组筛选" />
              <Select.Content>
                <Select.Item value="all">全部分组</Select.Item>
                {groups.map((group) => (
                  <Select.Item key={group} value={group}>{group}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>

            <Flex className="admin-sort-controls" gap="2" align="center">
              <SegmentedControl.Root value={sortKey} onValueChange={(value) => setSortKey(value as AdminSortKey)} size="1">
                <SegmentedControl.Item value="manual">手动</SegmentedControl.Item>
                <SegmentedControl.Item value="name">名称</SegmentedControl.Item>
                <SegmentedControl.Item value="status">状态</SegmentedControl.Item>
              </SegmentedControl.Root>
              <Button className="admin-sort-dir-button" variant="soft" size="1" disabled={sortKey === 'manual'} onClick={() => setSortDir((value) => value === 'asc' ? 'desc' : 'asc')}>
                {sortDir === 'asc' ? '升序' : '降序'}
              </Button>
            </Flex>
            <Button className="admin-add-server-button" size="1" onClick={() => setAddOpen(true)}><Plus size={16} /> 添加服务器</Button>
          </Flex>
        </Flex>
      </Card>

      <Card className="admin-node-card-panel">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filteredUuids} strategy={rectSortingStrategy}>
            <Flex className="admin-node-card-panel-header" justify="between" align="center" gap="2">
              <Text size="2" weight="bold">服务器节点</Text>
              <Flex align="center" gap="2">
                <Text size="1" color="gray">当前 {filtered.length} 个</Text>
                <Checkbox checked={allFilteredSelected} onCheckedChange={toggleSelectAll} />
              </Flex>
            </Flex>
            {filtered.length === 0 ? (
              <Text align="center" color="gray" style={{ display: 'block', padding: 24 }}>{search ? '未找到匹配的服务器' : '暂无服务器'}</Text>
            ) : (
              <div className="admin-node-card-grid">
                {filtered.map((client) => (
                  <SortableNodeCard
                    key={client.uuid}
                    node={client}
                    selected={selectedNodes.includes(client.uuid)}
                    onSelect={toggleSelect}
                    liveData={liveData}
                    dragDisabled={dragDisabled}
                    onDetail={(c) => { setDetailClient(c); setDetailOpen(true); }}
                    onEdit={(c) => { setEditClient(c); setEditOpen(true); }}
                    onDelete={(c) => { setDeleteClient(c); setDeleteOpen(true); }}
                    onCmd={(c) => { setCmdClient(c); setCmdOpen(true); }}
                    onRotateToken={(c) => { setRotateTokenClient(c); setRotateTokenOpen(true); }}
                  />
                ))}
              </div>
            )}
          </SortableContext>
        </DndContext>
      </Card>
      <BatchDeleteDialog
        count={selectedNodes.length}
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        onConfirm={batchDeleteNodes}
      />
      <AddDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(created) => {
          if (created) {
            const optimistic = optimisticAdminClient(created);
            setClients(prev => prev.some(client => client.uuid === created.uuid)
              ? prev
              : [...prev, optimistic]);
            notifyPublicDataUpdated({ clients: { upsert: [optimistic] } });
          } else {
            notifyPublicDataUpdated();
          }
          if (created?.token) {
            setCmdClient(created);
            setCmdOpen(true);
          }
        }}
      />
      <EditDialog client={editClient} open={editOpen} onOpenChange={setEditOpen} onSaved={(uuid, patch, saved) => {
        const updated = saved || { ...(editClient || { uuid }), ...patch, uuid };
        setClients((prev) => prev.map((client) => client.uuid === uuid ? { ...client, ...updated } : client));
        notifyPublicDataUpdated({
          clients: {
            upsert: [updated],
            remove: updated.hidden ? [uuid] : undefined,
          },
        });
      }} />
      <RotateTokenDialog
        client={rotateTokenClient}
        open={rotateTokenOpen}
        onOpenChange={setRotateTokenOpen}
        onRotated={(token) => {
          void loadClients(true);
          if (rotateTokenClient && token) {
            setCmdClient({ uuid: rotateTokenClient.uuid, name: rotateTokenClient.name, token });
            setCmdOpen(true);
          }
        }}
      />
      <DeleteDialog client={deleteClient} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={(uuid) => {
        setClients((prev) => prev.filter((client) => client.uuid !== uuid));
        notifyPublicDataUpdated({ clients: { remove: [uuid] } });
      }} />
      {detailClient && <DetailDialog client={detailClient} open={detailOpen} onOpenChange={setDetailOpen} />}
      {cmdClient && <GenerateCommandDialog client={cmdClient} open={cmdOpen} onOpenChange={setCmdOpen} />}
    </Flex>
  );
}

function BatchDeleteDialog({ count, open, onOpenChange, onConfirm }: { count: number; open: boolean; onOpenChange: (v: boolean) => void; onConfirm: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 400 }}>
        <Dialog.Title>批量删除确认</Dialog.Title>
        <Text size="2">确定要删除选中的 {count} 个节点吗？此操作不可撤销。</Text>
        <Flex gap="3" justify="end" mt="4">
          <Button variant="soft" onClick={() => onOpenChange(false)}>取消</Button>
          <Button color="red" onClick={onConfirm}>确认删除 {count} 个节点</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
