import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Flex, Text, Button, TextField,
  Dialog, Badge, Switch, Table, Tabs, Select,
  Box, Checkbox, TextArea,
} from '@radix-ui/themes';
import { Plus, Pencil, Trash2, Search, Send, Save, Unplug, TrendingUp, Bell, CalendarClock } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { SettingCard, SettingInput, SettingTextarea } from '../../components/admin/SettingCard';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';

const notificationTabValues = ['settings', 'offline', 'expiry', 'load'] as const;
type NotificationTab = typeof notificationTabValues[number];
type NotificationClient = {
  uuid: string;
  name?: string;
  ipv4?: string;
  ipv6?: string;
  region?: string;
  expired_at?: string;
};
type OfflineNotification = {
  client: string;
  enable?: boolean;
  grace_period?: number;
  last_notified?: string | null;
};
type ExpiryNotification = {
  client: string;
  enable?: boolean;
  advance_days?: number;
  last_notified?: string | null;
};
type LoadNotification = {
  id: number;
  name?: string;
  metric?: string;
  threshold?: number;
  ratio?: number;
  interval_min?: number;
  clients?: string[];
  all_clients?: boolean;
};
type LoadNotificationForm = Partial<LoadNotification> & {
  clients?: string[];
  all_clients?: boolean;
};
const emptyTabState: Record<NotificationTab, boolean> = {
  settings: false,
  offline: false,
  expiry: false,
  load: false,
};

function toNotificationTab(value?: string): NotificationTab {
  return notificationTabValues.includes(value as NotificationTab) ? value as NotificationTab : 'settings';
}

function NotificationTableHeader({ label, unit }: { label: string; unit?: string }) {
  return (
    <span className="notification-table-header">
      <span className="notification-table-header-label">{label}</span>
      {unit && <span className="notification-table-header-unit">{unit}</span>}
    </span>
  );
}

function clientDisplayIp(client: NotificationClient) {
  return client.ipv4 || client.ipv6 || '';
}

export default function AdminNotifications() {
  const apiFetch = useApi();
  const navigate = useNavigate();
  const { tab: urlTab } = useParams<{ tab?: string }>();
  const initialTab = toNotificationTab(urlTab);
  const [activeTab, setActiveTab] = useState<NotificationTab>(initialTab);
  const [tabLoading, setTabLoading] = useState<Record<NotificationTab, boolean>>({
    ...emptyTabState,
    [initialTab]: true,
  });
  const [loadedTabs, setLoadedTabs] = useState<Record<NotificationTab, boolean>>(emptyTabState);
  const [offlineNotifications, setOfflineNotifications] = useState<OfflineNotification[]>([]);
  const [expiryNotifications, setExpiryNotifications] = useState<ExpiryNotification[]>([]);
  const [clients, setClients] = useState<NotificationClient[]>([]);
  const [loadNotifications, setLoadNotifications] = useState<LoadNotification[]>([]);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  const [testEmailSending, setTestEmailSending] = useState(false);
  const [testWebhookSending, setTestWebhookSending] = useState(false);
  const [smtpOpen, setSmtpOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const clientsRef = useRef<NotificationClient[]>([]);
  const clientsLoadedRef = useRef(false);
  const clientsLoadPromiseRef = useRef<Promise<NotificationClient[]> | null>(null);

  const syncChannelCards = useCallback((method: string) => {
    setSmtpOpen(method === 'email');
    setTelegramOpen(method === 'telegram');
    setWebhookOpen(method === 'webhook');
  }, []);

  // Offline tab state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchForm, setBatchForm] = useState({ enable: true, grace_period: 180 });
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingOffline, setEditingOffline] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ enable: false, grace_period: 180 });
  const [expiryBatchDialogOpen, setExpiryBatchDialogOpen] = useState(false);
  const [expiryBatchForm, setExpiryBatchForm] = useState({ enable: true, advance_days: 7 });
  const [expiryEditDialogOpen, setExpiryEditDialogOpen] = useState(false);
  const [editingExpiry, setEditingExpiry] = useState<string | null>(null);
  const [expiryEditForm, setExpiryEditForm] = useState({ enable: false, advance_days: 7 });

  // Load tab state
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [editingLoad, setEditingLoad] = useState<LoadNotification | null>(null);
  const [loadForm, setLoadForm] = useState<LoadNotificationForm>({});

  useEffect(() => {
    setActiveTab(toNotificationTab(urlTab));
  }, [urlTab]);

  const handleTabChange = (value: string) => {
    const nextTab = toNotificationTab(value);
    setActiveTab(nextTab);
    setSelectedClients([]);
    navigate(`/admin/notifications/${nextTab}`);
  };

  const setTabBusy = useCallback((tab: NotificationTab, busy: boolean) => {
    setTabLoading((prev) => ({ ...prev, [tab]: busy }));
  }, []);

  const markTabLoaded = useCallback((tab: NotificationTab) => {
    setLoadedTabs((prev) => ({ ...prev, [tab]: true }));
  }, []);

  const ensureClientsLoaded = useCallback(async () => {
    if (clientsLoadedRef.current) return clientsRef.current;
    if (clientsLoadPromiseRef.current) return clientsLoadPromiseRef.current;

    const promise = apiFetch('/admin/clients')
      .then((data) => {
        const nextClients = Array.isArray(data) ? data as NotificationClient[] : [];
        clientsRef.current = nextClients;
        setClients(nextClients);
        clientsLoadedRef.current = true;
        return nextClients;
      })
      .finally(() => {
        clientsLoadPromiseRef.current = null;
      });
    clientsLoadPromiseRef.current = promise;
    return promise;
  }, [apiFetch]);

  const loadSettingsTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.settings) return;
    setTabBusy('settings', true);
    try {
      const settingsData = await apiFetch('/admin/settings?scope=notification');
      if (settingsData && typeof settingsData === 'object') {
        const nextSettings = settingsData as SettingsMap;
        setSettings(nextSettings);
        setOriginalSettings(nextSettings);
        syncChannelCards(nextSettings.notification_method || 'telegram');
      }
      markTabLoaded('settings');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '通知设置加载失败');
    } finally {
      setTabBusy('settings', false);
    }
  }, [apiFetch, loadedTabs.settings, markTabLoaded, setTabBusy, syncChannelCards]);

  const loadOfflineTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.offline) return;
    setTabBusy('offline', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/offline'),
      ensureClientsLoaded(),
    ]);
    const [offData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(offData)) setOfflineNotifications(offData as OfflineNotification[]);
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('离线通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('offline');
    }
    setTabBusy('offline', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.offline, markTabLoaded, setTabBusy]);

  const loadExpiryTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.expiry) return;
    setTabBusy('expiry', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/expiry'),
      ensureClientsLoaded(),
    ]);
    const [expiryData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(expiryData)) setExpiryNotifications(expiryData as ExpiryNotification[]);
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('到期通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('expiry');
    }
    setTabBusy('expiry', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.expiry, markTabLoaded, setTabBusy]);

  const loadLoadTab = useCallback(async (force = false) => {
    if (!force && loadedTabs.load) return;
    setTabBusy('load', true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/load'),
      ensureClientsLoaded(),
    ]);
    const [loadRulesData] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    if (Array.isArray(loadRulesData)) {
      setLoadNotifications((loadRulesData as LoadNotification[]).map((item) => ({
        ...item,
        clients: Array.isArray(item.clients) ? item.clients : [],
      })));
    }
    if (results.some((result) => result.status === 'rejected')) {
      toast.error('负载通知数据加载失败，请稍后刷新');
    } else {
      markTabLoaded('load');
    }
    setTabBusy('load', false);
  }, [apiFetch, ensureClientsLoaded, loadedTabs.load, markTabLoaded, setTabBusy]);

  const loadActiveTab = useCallback((tab: NotificationTab, force = false) => {
    if (tab === 'settings') return loadSettingsTab(force);
    if (tab === 'offline') return loadOfflineTab(force);
    if (tab === 'expiry') return loadExpiryTab(force);
    return loadLoadTab(force);
  }, [loadExpiryTab, loadLoadTab, loadOfflineTab, loadSettingsTab]);

  useEffect(() => {
    void loadActiveTab(activeTab);
  }, [activeTab, loadActiveTab]);

  // ─── Offline: search + filter ───
  const notificationMap = useMemo(() => {
    const map = new Map<string, OfflineNotification>();
    offlineNotifications.forEach((n) => map.set(n.client, n));
    return map;
  }, [offlineNotifications]);

  const expiryNotificationMap = useMemo(() => {
    const map = new Map<string, ExpiryNotification>();
    expiryNotifications.forEach((n) => map.set(n.client, n));
    return map;
  }, [expiryNotifications]);

  const filteredClients = useMemo(() => {
    if (!searchTerm.trim()) return clients;
    const term = searchTerm.toLowerCase();
    return clients.filter((c) =>
      c.name?.toLowerCase().includes(term) ||
      clientDisplayIp(c).toLowerCase().includes(term) ||
      c.region?.toLowerCase().includes(term)
    );
  }, [clients, searchTerm]);

  // ─── Offline: toggle ───
  const toggleOffline = async (clientUuid: string, enable: boolean) => {
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable, grace_period: 180 }),
    });
    if (result.success) {
      toast.success(enable ? '已开启离线通知' : '已关闭离线通知');
      void loadOfflineTab(true);
    } else {
      toast.error('操作失败');
    }
  };

  // ─── Offline: single edit ───
  const openEditDialog = (clientUuid: string) => {
    const existing = notificationMap.get(clientUuid);
    setEditingOffline(clientUuid);
    setEditForm({
      enable: existing?.enable || false,
      grace_period: existing?.grace_period || 180,
    });
    setEditDialogOpen(true);
  };

  const saveSingleEdit = async () => {
    if (!editingOffline) return;
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify({
        client: editingOffline,
        enable: editForm.enable,
        grace_period: editForm.grace_period,
      }),
    });
    if (result.success) {
      toast.success('已更新');
      setEditDialogOpen(false);
      void loadOfflineTab(true);
    } else {
      toast.error('更新失败');
    }
  };

  // ─── Offline: batch edit ───
  const openBatchDialog = () => {
    if (selectedClients.length === 0) {
      toast.error('请先选择服务器');
      return;
    }
    setBatchForm({ enable: true, grace_period: 180 });
    setBatchDialogOpen(true);
  };

  const saveBatchEdit = async () => {
    const payload = selectedClients.map((uuid) => ({
      client: uuid,
      enable: batchForm.enable,
      grace_period: batchForm.grace_period,
    }));
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.success) {
      toast.success(`已批量更新 ${selectedClients.length} 个节点`);
      setBatchDialogOpen(false);
      setSelectedClients([]);
      void loadOfflineTab(true);
    } else {
      toast.error('批量更新失败');
    }
  };

  const toggleSelectAll = () => {
    if (selectedClients.length === filteredClients.length) {
      setSelectedClients([]);
    } else {
      setSelectedClients(filteredClients.map((c) => c.uuid));
    }
  };

  const toggleExpiry = async (clientUuid: string, enable: boolean) => {
    const existing = expiryNotificationMap.get(clientUuid);
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable, advance_days: existing?.advance_days || 7 }),
    });
    if (result.success) {
      toast.success(enable ? '已开启到期通知' : '已关闭到期通知');
      void loadExpiryTab(true);
    } else {
      toast.error('操作失败');
    }
  };

  const openExpiryEditDialog = (clientUuid: string) => {
    const existing = expiryNotificationMap.get(clientUuid);
    setEditingExpiry(clientUuid);
    setExpiryEditForm({
      enable: existing?.enable || false,
      advance_days: existing?.advance_days || 7,
    });
    setExpiryEditDialogOpen(true);
  };

  const saveExpirySingleEdit = async () => {
    if (!editingExpiry) return;
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify({
        client: editingExpiry,
        enable: expiryEditForm.enable,
        advance_days: expiryEditForm.advance_days,
      }),
    });
    if (result.success) {
      toast.success('已更新');
      setExpiryEditDialogOpen(false);
      void loadExpiryTab(true);
    } else {
      toast.error('更新失败');
    }
  };

  const openExpiryBatchDialog = () => {
    if (selectedClients.length === 0) {
      toast.error('请先选择服务器');
      return;
    }
    setExpiryBatchForm({ enable: true, advance_days: 7 });
    setExpiryBatchDialogOpen(true);
  };

  const saveExpiryBatchEdit = async () => {
    const payload = selectedClients.map((uuid) => ({
      client: uuid,
      enable: expiryBatchForm.enable,
      advance_days: expiryBatchForm.advance_days,
    }));
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.success) {
      toast.success(`已批量更新 ${selectedClients.length} 个节点`);
      setExpiryBatchDialogOpen(false);
      setSelectedClients([]);
      void loadExpiryTab(true);
    } else {
      toast.error('批量更新失败');
    }
  };

  // ─── Settings: global notification channel ───
  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateSensitiveWebhookSetting = (
    key: 'webhook_url' | 'webhook_secret' | 'webhook_headers_json' | 'webhook_password',
    value: string,
  ) => {
    const clearKey = key === 'webhook_url'
      ? 'webhook_url_clear'
      : key === 'webhook_secret'
        ? 'webhook_secret_clear'
        : '';
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (value && clearKey) delete next[clearKey];
      return next;
    });
  };

  const handleNotificationMethodChange = (value: string) => {
    updateSetting('notification_method', value);
    syncChannelCards(value);
  };

  const saveNotificationSettings = async () => {
    const payload = { ...settings };
    delete payload.email_smtp_password_set;
    delete payload.webhook_url_set;
    delete payload.webhook_secret_set;
    delete payload.webhook_headers_set;
    delete payload.webhook_password_set;
    delete payload.webhook_url_host;
    if (!payload.email_smtp_password) {
      delete payload.email_smtp_password;
    }
    if (payload.webhook_url_clear !== 'true') {
      delete payload.webhook_url_clear;
    }
    if (payload.webhook_secret_clear !== 'true') {
      delete payload.webhook_secret_clear;
    }
    if (!payload.webhook_url && payload.webhook_url_clear !== 'true') {
      delete payload.webhook_url;
    }
    if (!payload.webhook_secret && payload.webhook_secret_clear !== 'true') {
      delete payload.webhook_secret;
    }
    if (!payload.webhook_headers_json) {
      delete payload.webhook_headers_json;
    }
    if (!payload.webhook_password) {
      delete payload.webhook_password;
    }
    const changedSettings = getChangedSettings(payload, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSettingsSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        await loadSettingsTab(true);
        toast.success('通知设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  // ─── Load: crud ───
  const openLoadAdd = () => {
    setEditingLoad(null);
    setLoadForm({
      name: '',
      metric: 'cpu',
      threshold: 80,
      ratio: 0.8,
      interval_min: 15,
      clients: [],
      all_clients: true,
    });
    setLoadDialogOpen(true);
  };

  const openLoadEdit = (item: LoadNotification) => {
    setEditingLoad(item);
    setLoadForm({
      ...item,
      all_clients: !item.clients || item.clients.length === 0,
    });
    setLoadDialogOpen(true);
  };

  const saveLoadNotification = async () => {
    const payload = {
      ...loadForm,
      clients: loadForm.all_clients ? [] : loadForm.clients || [],
    };

    if (editingLoad?.id) {
      const result = await apiFetch(`/admin/notification/load/${editingLoad.id}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        toast.success('已更新');
        setLoadDialogOpen(false);
        void loadLoadTab(true);
      } else {
        toast.error('更新失败');
      }
    } else {
      const result = await apiFetch('/admin/notification/load/add', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        toast.success('已添加');
        setLoadDialogOpen(false);
        void loadLoadTab(true);
      } else {
        toast.error('添加失败');
      }
    }
  };

  const deleteLoadNotification = async (id: number) => {
    const result = await apiFetch(`/admin/notification/load/${id}`, {
      method: 'DELETE',
    });
    if (result.success) {
      toast.success('已删除');
      void loadLoadTab(true);
    } else {
      toast.error('删除失败');
    }
  };

  // ─── Test message ───
  const sendTestMessage = async () => {
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({ message: 'CF VPS Monitor 测试消息 - 通知配置成功!' }),
      });
      if (result.success) {
        toast.success('测试消息已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    }
  };

  const sendTestEmail = async () => {
    setTestEmailSending(true);
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'email',
          message: 'CF VPS Monitor 测试消息 - 邮件通知配置成功!',
          test_recipient: testRecipient.trim(),
        }),
      });
      if (result.success) {
        toast.success('测试邮件已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    } finally {
      setTestEmailSending(false);
    }
  };

  const sendTestWebhook = async () => {
    setTestWebhookSending(true);
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'webhook',
          message: 'CF VPS Monitor 测试消息 - Webhook 通知配置成功!',
        }),
      });
      if (result.success) {
        toast.success('Webhook 测试消息已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    } finally {
      setTestWebhookSending(false);
    }
  };

  const offlineStatsCount = offlineNotifications.filter((n) => n.enable).length;
  const expiryStatsCount = expiryNotifications.filter((n) => n.enable).length;
  const notificationMethod = settings.notification_method || 'telegram';
  const webhookFormat = settings.webhook_format || 'generic';
  const webhookSecretHint = webhookFormat === 'feishu' || webhookFormat === 'dingtalk'
    ? '用于平台签名校验'
    : webhookFormat === 'generic'
      ? '通用格式用于 HMAC'
      : webhookFormat === 'custom'
        ? '自定义模式可留空'
        : '当前平台通常不需要 Secret';
  const notificationMethodLabel = notificationMethod === 'email'
    ? 'SMTP 邮件'
    : notificationMethod === 'webhook'
      ? 'Webhook'
      : notificationMethod === 'none'
        ? '关闭'
        : 'Telegram';
  const notificationMethodBadgeColor = notificationMethod === 'email'
    ? 'blue'
    : notificationMethod === 'webhook'
      ? 'amber'
      : notificationMethod === 'none'
        ? 'gray'
        : 'green';
  const showClientSearch = activeTab === 'offline' || activeTab === 'expiry';
  const headerAction = activeTab === 'settings' ? (
    <Button onClick={saveNotificationSettings} disabled={settingsSaving || tabLoading.settings}>
      <Save size={14} /> {settingsSaving ? '保存中…' : '保存设置'}
    </Button>
  ) : activeTab === 'offline' ? (
    <Button
      variant="soft"
      onClick={openBatchDialog}
      disabled={tabLoading.offline || selectedClients.length === 0}
    >
      <Pencil size={14} /> 批量编辑 ({selectedClients.length})
    </Button>
  ) : activeTab === 'expiry' ? (
    <Button
      variant="soft"
      onClick={openExpiryBatchDialog}
      disabled={tabLoading.expiry || selectedClients.length === 0}
    >
      <Pencil size={14} /> 批量编辑 ({selectedClients.length})
    </Button>
  ) : (
    <Button onClick={openLoadAdd} disabled={tabLoading.load}><Plus size={14} /> 新建规则</Button>
  );

  return (
    <div className="admin-notifications-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Bell size={20} />
          <Text size="5" weight="bold">通知管理</Text>
        </Flex>
      </Flex>

      <Tabs.Root value={activeTab} onValueChange={handleTabChange}>
        <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3" mb={showClientSearch ? '2' : '3'}>
          <Tabs.List className="admin-subnav-row">
            <Tabs.Trigger value="settings">
              <Bell size={14} /> 通知设置
            </Tabs.Trigger>
            <Tabs.Trigger value="offline">
              <Unplug size={14} /> {loadedTabs.offline ? `离线通知 (${offlineStatsCount} 开启)` : '离线通知'}
            </Tabs.Trigger>
            <Tabs.Trigger value="expiry">
              <CalendarClock size={14} /> {loadedTabs.expiry ? `到期通知 (${expiryStatsCount} 开启)` : '到期通知'}
            </Tabs.Trigger>
            <Tabs.Trigger value="load">
              <TrendingUp size={14} /> {loadedTabs.load ? `负载通知 (${loadNotifications.length} 条)` : '负载通知'}
            </Tabs.Trigger>
          </Tabs.List>
          {!showClientSearch && (
            <Flex className="admin-subnav-actions" align="center" gap="2">{headerAction}</Flex>
          )}
        </Flex>

        {showClientSearch && (
          <Flex className="notification-client-toolbar" align="center" justify="between" gap="2" mb="3">
            <TextField.Root
              className="notification-inline-search"
              placeholder="搜索服务器"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            >
              <TextField.Slot><Search size={14} /></TextField.Slot>
            </TextField.Root>
            <Flex className="notification-client-toolbar-actions" align="center" gap="2">{headerAction}</Flex>
          </Flex>
        )}

        <Box>
          {/* ─── Settings Tab ─── */}
          <Tabs.Content value="settings">
            {tabLoading.settings ? (
              <Loading />
            ) : (
              <Flex direction="column" gap="4">
                <SettingCard title="通知通道" description="选择全局通知发送方式" defaultOpen>
                  <div className="notification-channel-row">
                    <Box>
                      <Text size="1" color="gray">选择全局通知发送方式</Text>
                    </Box>
                    <div className="notification-channel-controls">
                      <Select.Root
                        value={notificationMethod}
                        onValueChange={handleNotificationMethodChange}
                      >
                        <Select.Trigger className="notification-method-select" />
                        <Select.Content>
                          <Select.Item value="none">关闭</Select.Item>
                          <Select.Item value="telegram">Telegram</Select.Item>
                          <Select.Item value="email">SMTP 邮件</Select.Item>
                          <Select.Item value="webhook">Webhook</Select.Item>
                        </Select.Content>
                      </Select.Root>
                      <Badge color={notificationMethodBadgeColor} variant="soft">{notificationMethodLabel}</Badge>
                    </div>
                  </div>
                </SettingCard>

                <SettingCard
                  title="SMTP 邮件通知"
                  description="发件服务器、账号和默认收件人"
                  open={smtpOpen}
                  onOpenChange={setSmtpOpen}
                >
                    <div className="notification-email-form-grid">
                      <div className="notification-email-connection-grid">
                        <div className="notification-email-host">
                          <SettingInput
                            label="SMTP Host"
                            value={settings.email_smtp_host || ''}
                            onChange={(value) => updateSetting('email_smtp_host', value)}
                            placeholder="smtp.example.com"
                            width="24ch"
                          />
                        </div>
                        <div className="notification-email-port">
                          <SettingInput
                            label="Port"
                            value={settings.email_smtp_port || '587'}
                            onChange={(value) => updateSetting('email_smtp_port', value)}
                            type="number"
                            width="8ch"
                          />
                        </div>
                        <label className="notification-email-field notification-email-security">
                          <Text className="notification-email-label" size="2" weight="medium">安全模式</Text>
                          <Select.Root
                            value={settings.email_smtp_security || 'starttls'}
                            onValueChange={(value) => updateSetting('email_smtp_security', value)}
                          >
                            <Select.Trigger />
                            <Select.Content>
                              <Select.Item value="starttls">STARTTLS (587)</Select.Item>
                              <Select.Item value="tls">隐式 TLS (465)</Select.Item>
                            </Select.Content>
                          </Select.Root>
                        </label>
                        <label className="notification-email-field notification-email-auth">
                          <Text className="notification-email-label" size="2" weight="medium">认证方式</Text>
                          <Select.Root
                            value={settings.email_smtp_auth_method || 'plain'}
                            onValueChange={(value) => updateSetting('email_smtp_auth_method', value)}
                          >
                            <Select.Trigger />
                            <Select.Content>
                              <Select.Item value="plain">PLAIN</Select.Item>
                              <Select.Item value="login">LOGIN</Select.Item>
                            </Select.Content>
                          </Select.Root>
                        </label>
                      </div>
                      <div className="notification-email-identity-grid">
                        <div>
                          <SettingInput
                            label="用户名"
                            value={settings.email_smtp_username || ''}
                            onChange={(value) => updateSetting('email_smtp_username', value)}
                            placeholder="user@example.com"
                            width="32ch"
                          />
                        </div>
                        <div>
                          <SettingInput
                            label="密码"
                            type="password"
                            value={settings.email_smtp_password || ''}
                            onChange={(value) => updateSetting('email_smtp_password', value)}
                            placeholder={settings.email_smtp_password_set === 'true' ? '已保存密码，留空则不修改' : 'SMTP 密码或授权码'}
                            width="34ch"
                          />
                        </div>
                        <div>
                          <SettingInput
                            label="发件人邮箱"
                            value={settings.email_smtp_from_address || ''}
                            onChange={(value) => updateSetting('email_smtp_from_address', value)}
                            placeholder="monitor@example.com"
                            width="32ch"
                          />
                        </div>
                        <div>
                          <SettingInput
                            label="发件人名称"
                            value={settings.email_smtp_from_name || 'CF VPS Monitor'}
                            onChange={(value) => updateSetting('email_smtp_from_name', value)}
                            width="18ch"
                          />
                        </div>
                      </div>
                      <div className="notification-email-recipients">
                        <SettingTextarea
                          label="收件地址"
                          description="支持逗号、分号或换行分隔，最多 20 个"
                          value={settings.email_smtp_recipients || ''}
                          onChange={(value) => updateSetting('email_smtp_recipients', value)}
                          rows={3}
                          placeholder={'admin@example.com\nops@example.com'}
                        />
                      </div>
                      <div className="notification-email-test-row" aria-label="SMTP 测试">
                        <TextField.Root
                          className="notification-email-test-input"
                          size="1"
                          placeholder="测试收件人，留空使用默认收件地址"
                          value={testRecipient}
                          onChange={(event) => setTestRecipient(event.target.value)}
                        />
                        <Button size="1" className="notification-email-test-button" variant="soft" onClick={sendTestEmail} disabled={testEmailSending}>
                          <Send size={13} /> {testEmailSending ? '发送中…' : 'SMTP 测试'}
                        </Button>
                      </div>
                    </div>
                </SettingCard>

                <SettingCard
                  title="Telegram 通知"
                  description="Bot 与辅助告警策略"
                  open={telegramOpen}
                  onOpenChange={setTelegramOpen}
                >
                    <div className="notification-telegram-grid">
                      <div>
                        <SettingInput
                          label="Bot Token"
                          description="从 @BotFather 获取"
                          value={settings.telegram_bot_token || ''}
                          onChange={(value) => updateSetting('telegram_bot_token', value)}
                          placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                          width="52ch"
                        />
                      </div>
                      <div>
                        <SettingInput
                          label="Chat ID"
                          description="群组或用户 Chat ID"
                          value={settings.telegram_chat_id || ''}
                          onChange={(value) => updateSetting('telegram_chat_id', value)}
                          placeholder="-1001234567890"
                          width="18ch"
                        />
                      </div>
                    </div>
                    <div className="notification-telegram-test-row" aria-label="Telegram 测试">
                      <Button size="1" className="notification-telegram-test-button" variant="soft" onClick={sendTestMessage}>
                        <Send size={13} /> Telegram 测试
                      </Button>
                    </div>
                </SettingCard>

                <SettingCard
                  title="Webhook 通知"
                  description="HTTPS 回调地址和消息格式"
                  open={webhookOpen}
                  onOpenChange={setWebhookOpen}
                >
                    <div className="notification-webhook-form-grid">
                      <div className="notification-webhook-url-row">
                        <label className="notification-webhook-field">
                          <Text className="notification-webhook-field-label" size="2" weight="medium">Webhook URL</Text>
                          <Text className="notification-webhook-field-description" size="1" color="gray">
                            {settings.webhook_url_host
                              ? `当前 Host：${settings.webhook_url_host}`
                              : settings.webhook_url_set === 'true'
                                ? '已配置 URL，留空则不修改'
                                : '仅支持 HTTPS URL'}
                          </Text>
                          <TextField.Root
                            size="2"
                            value={settings.webhook_url || ''}
                            onChange={(event) => updateSensitiveWebhookSetting('webhook_url', event.target.value)}
                            placeholder={settings.webhook_url_set === 'true' ? '已保存 URL，留空则不修改' : 'https://hooks.example.com/...'}
                          />
                        </label>
                      </div>
                      <div className="notification-webhook-options-grid">
                        <label className="notification-webhook-field">
                          <Text className="notification-webhook-field-label" size="2" weight="medium">消息格式</Text>
                          <Text className="notification-webhook-field-description" size="1" color="gray">选择回调消息格式</Text>
                          <Select.Root
                            value={webhookFormat}
                            onValueChange={(value) => updateSetting('webhook_format', value)}
                          >
                            <Select.Trigger style={{ width: '100%' }} />
                            <Select.Content>
                              <Select.Item value="generic">通用 JSON</Select.Item>
                              <Select.Item value="slack">Slack</Select.Item>
                              <Select.Item value="discord">Discord</Select.Item>
                              <Select.Item value="feishu">飞书</Select.Item>
                              <Select.Item value="dingtalk">钉钉</Select.Item>
                              <Select.Item value="wecom">企业微信</Select.Item>
                              <Select.Item value="custom">Custom</Select.Item>
                            </Select.Content>
                          </Select.Root>
                        </label>
                        <div className="notification-webhook-secret">
                          <label className="notification-webhook-field">
                            <Text className="notification-webhook-field-label" size="2" weight="medium">Secret</Text>
                            <Text className="notification-webhook-field-description" size="1" color="gray">{webhookSecretHint}</Text>
                            <TextField.Root
                              size="2"
                              type="password"
                              value={settings.webhook_secret || ''}
                              onChange={(event) => updateSensitiveWebhookSetting('webhook_secret', event.target.value)}
                              placeholder={settings.webhook_secret_set === 'true' ? '已保存 Secret，留空则不修改' : '可选'}
                            />
                          </label>
                        </div>
                      </div>
                      <div className="notification-webhook-actions" aria-label="Webhook 操作">
                        {webhookFormat === 'custom' && (
                          <div className="notification-webhook-custom-grid">
                            <label className="notification-webhook-field">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">请求方法</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">GET 适合 URL 参数类接口，POST 适合请求体模板</Text>
                              <Select.Root
                                value={settings.webhook_method || 'POST'}
                                onValueChange={(value) => updateSetting('webhook_method', value)}
                              >
                                <Select.Trigger style={{ width: '100%' }} />
                                <Select.Content>
                                  <Select.Item value="POST">POST</Select.Item>
                                  <Select.Item value="GET">GET</Select.Item>
                                </Select.Content>
                              </Select.Root>
                            </label>
                            <label className="notification-webhook-field">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">Content-Type</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">POST custom 请求使用</Text>
                              <TextField.Root
                                size="2"
                                value={settings.webhook_content_type || 'application/json'}
                                onChange={(event) => updateSetting('webhook_content_type', event.target.value)}
                                placeholder="application/json"
                              />
                            </label>
                            <label className="notification-webhook-field">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">重试次数</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">失败时最多重试 3 次</Text>
                              <Select.Root
                                value={settings.webhook_retry_count || '1'}
                                onValueChange={(value) => updateSetting('webhook_retry_count', value)}
                              >
                                <Select.Trigger style={{ width: '100%' }} />
                                <Select.Content>
                                  <Select.Item value="1">1</Select.Item>
                                  <Select.Item value="2">2</Select.Item>
                                  <Select.Item value="3">3</Select.Item>
                                </Select.Content>
                              </Select.Root>
                            </label>
                            <label className="notification-webhook-field">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">Basic Auth 用户名</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">不需要认证可留空</Text>
                              <TextField.Root
                                size="2"
                                value={settings.webhook_username || ''}
                                onChange={(event) => updateSetting('webhook_username', event.target.value)}
                                placeholder="username"
                              />
                            </label>
                            <label className="notification-webhook-field notification-webhook-wide">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">Headers JSON</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">
                                {settings.webhook_headers_set === 'true' ? '已保存 Headers，留空则不修改' : '键和值都必须是字符串，不要同时配置 Authorization 与 Basic Auth'}
                              </Text>
                              <TextArea
                                size="2"
                                rows={3}
                                value={settings.webhook_headers_json || ''}
                                onChange={(event) => updateSensitiveWebhookSetting('webhook_headers_json', event.target.value)}
                                placeholder='{"X-Token":"token"}'
                              />
                            </label>
                            <label className="notification-webhook-field notification-webhook-wide">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">Body 模板</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">
                                {'可用变量：{{title}} {{message}} {{event}} {{client}} {{time}} {{emoji}} {{source}}'}
                              </Text>
                              <TextArea
                                size="2"
                                rows={4}
                                value={settings.webhook_body_template || '{"message":"{{message}}","title":"{{title}}"}'}
                                onChange={(event) => updateSetting('webhook_body_template', event.target.value)}
                              />
                            </label>
                            <label className="notification-webhook-field">
                              <Text className="notification-webhook-field-label" size="2" weight="medium">Basic Auth 密码</Text>
                              <Text className="notification-webhook-field-description" size="1" color="gray">
                                {settings.webhook_password_set === 'true' ? '已保存密码，留空则不修改' : '可选'}
                              </Text>
                              <TextField.Root
                                size="2"
                                type="password"
                                value={settings.webhook_password || ''}
                                onChange={(event) => updateSensitiveWebhookSetting('webhook_password', event.target.value)}
                                placeholder={settings.webhook_password_set === 'true' ? '已保存密码，留空则不修改' : 'password'}
                              />
                            </label>
                          </div>
                        )}
                        <Button
                          size="1"
                          className="notification-webhook-test-button"
                          variant="soft"
                          onClick={sendTestWebhook}
                          disabled={testWebhookSending}
                        >
                          <Send size={13} /> {testWebhookSending ? '发送中…' : 'Webhook 测试'}
                        </Button>
                      </div>
                    </div>
                </SettingCard>
              </Flex>
            )}
          </Tabs.Content>

          {/* ─── Offline Tab ─── */}
          <Tabs.Content value="offline">
            {tabLoading.offline ? (
              <Loading />
            ) : (
              <>
            {filteredClients.length === 0 ? (
              <Flex justify="center" py="6">
                <Text color="gray">暂无匹配的服务器</Text>
              </Flex>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
              <Table.Root className="notification-config-table" variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell width="40px">
                      <Checkbox
                        checked={selectedClients.length === filteredClients.length && filteredClients.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>服务器</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="76px"><NotificationTableHeader label="状态" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="112px"><NotificationTableHeader label="宽限期" unit="秒" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="170px"><NotificationTableHeader label="最后通知" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="132px"><NotificationTableHeader label="操作" /></Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredClients.map((client) => {
                    const notification = notificationMap.get(client.uuid);
                    const displayIp = clientDisplayIp(client);
                    const enabled = notification?.enable || false;
                    const gracePeriod = notification?.grace_period || 180;
                    const lastNotified = notification?.last_notified;
                    const lastNotifiedText = lastNotified
                      ? new Date(lastNotified).getFullYear() < 2000
                        ? '从未触发'
                        : new Date(lastNotified).toLocaleString('zh-CN')
                      : '-';

                    return (
                      <Table.Row key={client.uuid}>
                        <Table.Cell>
                          <Checkbox
                            checked={selectedClients.includes(client.uuid)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedClients([...selectedClients, client.uuid]);
                              } else {
                                setSelectedClients(selectedClients.filter((id) => id !== client.uuid));
                              }
                            }}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2" weight="medium">{client.name || '未命名'}</Text>
                          {displayIp && <Text size="1" color="gray" ml="2">{displayIp}</Text>}
                        </Table.Cell>
                        <Table.Cell>
                          <Switch
                            size="1"
                            checked={enabled}
                            onCheckedChange={(v) => toggleOffline(client.uuid, v)}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">{gracePeriod}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="1" color="gray">{lastNotifiedText}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Button size="1" variant="soft" onClick={() => openEditDialog(client.uuid)}>
                            <Pencil size={13} /> 编辑
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
              </div>
            )}
              </>
            )}
          </Tabs.Content>

          {/* ─── Expiry Tab ─── */}
          <Tabs.Content value="expiry">
            {tabLoading.expiry ? (
              <Loading />
            ) : (
              <>
            {filteredClients.length === 0 ? (
              <Flex justify="center" py="6">
                <Text color="gray">暂无匹配的服务器</Text>
              </Flex>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
              <Table.Root className="notification-config-table" variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell width="40px">
                      <Checkbox
                        checked={selectedClients.length === filteredClients.length && filteredClients.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>服务器</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="76px"><NotificationTableHeader label="状态" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="112px"><NotificationTableHeader label="提前提醒" unit="天" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="150px"><NotificationTableHeader label="到期时间" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="170px"><NotificationTableHeader label="最后通知" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="132px"><NotificationTableHeader label="操作" /></Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredClients.map((client) => {
                    const notification = expiryNotificationMap.get(client.uuid);
                    const displayIp = clientDisplayIp(client);
                    const enabled = notification?.enable || false;
                    const advanceDays = notification?.advance_days || 7;
                    const lastNotified = notification?.last_notified;
                    const lastNotifiedText = lastNotified
                      ? new Date(lastNotified).getFullYear() < 2000
                        ? '从未触发'
                        : new Date(lastNotified).toLocaleString('zh-CN')
                      : '-';
                    const expiredAtText = client.expired_at
                      ? new Date(client.expired_at).toLocaleDateString('zh-CN')
                      : '未设置';

                    return (
                      <Table.Row key={client.uuid}>
                        <Table.Cell>
                          <Checkbox
                            checked={selectedClients.includes(client.uuid)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedClients([...selectedClients, client.uuid]);
                              } else {
                                setSelectedClients(selectedClients.filter((id) => id !== client.uuid));
                              }
                            }}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2" weight="medium">{client.name || '未命名'}</Text>
                          {displayIp && <Text size="1" color="gray" ml="2">{displayIp}</Text>}
                        </Table.Cell>
                        <Table.Cell>
                          <Switch
                            size="1"
                            checked={enabled}
                            onCheckedChange={(v) => toggleExpiry(client.uuid, v)}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">{advanceDays} 天</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="1" color={client.expired_at ? 'gray' : 'amber'}>{expiredAtText}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="1" color="gray">{lastNotifiedText}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Button size="1" variant="soft" onClick={() => openExpiryEditDialog(client.uuid)}>
                            <Pencil size={13} /> 编辑
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
              </div>
            )}
              </>
            )}
          </Tabs.Content>

          {/* ─── Load Tab ─── */}
          <Tabs.Content value="load">
            {tabLoading.load ? (
              <Loading />
            ) : loadNotifications.length === 0 ? (
              <Flex justify="center" py="6" direction="column" align="center" gap="2">
                <TrendingUp size={32} color="var(--gray-6)" />
                <Text color="gray">暂无负载通知规则</Text>
                <Button variant="soft" size="1" onClick={openLoadAdd}><Plus size={14} /> 新建规则</Button>
              </Flex>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
              <Table.Root className="notification-config-table notification-load-table" variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell width="280px">名称</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="88px"><NotificationTableHeader label="指标" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="88px"><NotificationTableHeader label="阈值" unit="%" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="88px"><NotificationTableHeader label="达标率" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="112px"><NotificationTableHeader label="监测间隔" unit="分钟" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="100px"><NotificationTableHeader label="范围" /></Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="132px"><NotificationTableHeader label="操作" /></Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {loadNotifications.map((item) => (
                    <Table.Row key={item.id}>
                      <Table.Cell style={{ maxWidth: 280 }}>
                        <Text
                          size="2"
                          weight="medium"
                          style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {item.name || '未命名规则'}
                        </Text>
                      </Table.Cell>
                      <Table.Cell><Badge variant="soft" size="1">{item.metric || 'cpu'}</Badge></Table.Cell>
                      <Table.Cell><Text size="2">{item.threshold || 80}%</Text></Table.Cell>
                      <Table.Cell><Text size="2">{((item.ratio || 0.8) * 100).toFixed(0)}%</Text></Table.Cell>
                      <Table.Cell><Text size="2">{item.interval_min || 15} min</Text></Table.Cell>
                      <Table.Cell>
                        <Badge variant="soft" size="1" color={item.all_clients || !item.clients || item.clients.length === 0 ? 'blue' : 'amber'}>
                          {item.all_clients || !item.clients || item.clients.length === 0 ? '全节点' : `${item.clients?.length || 0} 节点`}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex gap="1" wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>
                          <Button size="1" variant="soft" onClick={() => openLoadEdit(item)}>
                            <Pencil size={13} /> 编辑
                          </Button>
                          <Button size="1" variant="soft" color="red" onClick={() => deleteLoadNotification(item.id)}>
                            <Trash2 size={13} /> 删除
                          </Button>
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
              </div>
            )}
          </Tabs.Content>
        </Box>
      </Tabs.Root>

      {/* ─── Offline Single Edit Dialog ─── */}
      <Dialog.Root open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>编辑离线通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            {editingOffline && (
              <Text size="2">{clients.find((c) => c.uuid === editingOffline)?.name || editingOffline}</Text>
            )}
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={editForm.enable} onCheckedChange={(v) => setEditForm({ ...editForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{editForm.enable ? '已开启' : '已关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">宽限期 (秒)</Text>
              <TextField.Root
                type="number"
                value={editForm.grace_period}
                onChange={(e) => setEditForm({ ...editForm, grace_period: Number(e.target.value) })}
                mt="1"
              />
              <Text size="1" color="gray" mt="1">
                服务器离线超过该时间后才会发送通知，避免网络抖动误报
              </Text>
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setEditDialogOpen(false)}>取消</Button>
            <Button onClick={saveSingleEdit}>保存</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Batch Edit Dialog ─── */}
      <Dialog.Root open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>批量编辑离线通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            将为 {selectedClients.length} 个选中节点统一设置离线通知参数
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={batchForm.enable} onCheckedChange={(v) => setBatchForm({ ...batchForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{batchForm.enable ? '开启' : '关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">宽限期 (秒)</Text>
              <TextField.Root
                type="number"
                value={batchForm.grace_period}
                onChange={(e) => setBatchForm({ ...batchForm, grace_period: Number(e.target.value) })}
                mt="1"
              />
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setBatchDialogOpen(false)}>取消</Button>
            <Button onClick={saveBatchEdit}>保存 ({selectedClients.length} 节点)</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Expiry Single Edit Dialog ─── */}
      <Dialog.Root open={expiryEditDialogOpen} onOpenChange={setExpiryEditDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>编辑到期通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            {editingExpiry && (
              <Text size="2">{clients.find((c) => c.uuid === editingExpiry)?.name || editingExpiry}</Text>
            )}
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={expiryEditForm.enable} onCheckedChange={(v) => setExpiryEditForm({ ...expiryEditForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{expiryEditForm.enable ? '已开启' : '已关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">提前天数</Text>
              <TextField.Root
                type="number"
                min="1"
                max="365"
                value={expiryEditForm.advance_days}
                onChange={(e) => setExpiryEditForm({ ...expiryEditForm, advance_days: Number(e.target.value) })}
                mt="1"
              />
              <Text size="1" color="gray" mt="1">
                节点到期前进入该天数窗口时发送一次提醒
              </Text>
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setExpiryEditDialogOpen(false)}>取消</Button>
            <Button onClick={saveExpirySingleEdit}>保存</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Expiry Batch Edit Dialog ─── */}
      <Dialog.Root open={expiryBatchDialogOpen} onOpenChange={setExpiryBatchDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>批量编辑到期通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            将为 {selectedClients.length} 个选中节点统一设置到期提醒参数
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={expiryBatchForm.enable} onCheckedChange={(v) => setExpiryBatchForm({ ...expiryBatchForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{expiryBatchForm.enable ? '开启' : '关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">提前天数</Text>
              <TextField.Root
                type="number"
                min="1"
                max="365"
                value={expiryBatchForm.advance_days}
                onChange={(e) => setExpiryBatchForm({ ...expiryBatchForm, advance_days: Number(e.target.value) })}
                mt="1"
              />
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setExpiryBatchDialogOpen(false)}>取消</Button>
            <Button onClick={saveExpiryBatchEdit}>保存 ({selectedClients.length} 节点)</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Load Add/Edit Dialog ─── */}
      <Dialog.Root open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <Dialog.Content aria-describedby={undefined} style={{ maxWidth: 480 }}>
          <Dialog.Title>{editingLoad ? '编辑负载通知规则' : '新建负载通知规则'}</Dialog.Title>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">规则名称</Text>
              <TextField.Root
                placeholder="CPU 高负载告警"
                value={loadForm.name || ''}
                onChange={(e) => setLoadForm({ ...loadForm, name: e.target.value })}
                mt="1"
              />
            </label>
            <label>
              <Text size="2" weight="bold">监测指标</Text>
              <Select.Root value={loadForm.metric || 'cpu'} onValueChange={(v) => setLoadForm({ ...loadForm, metric: v })}>
                <Select.Trigger style={{ width: '100%', marginTop: 4 }} />
                <Select.Content>
                  <Select.Item value="cpu">CPU 使用率</Select.Item>
                  <Select.Item value="ram">内存使用率</Select.Item>
                  <Select.Item value="load">系统负载</Select.Item>
                  <Select.Item value="disk">磁盘使用率</Select.Item>
                  <Select.Item value="temp">温度</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
            <Flex gap="3">
              <label style={{ flex: 1 }}>
                <Text size="2" weight="bold">阈值 (%)</Text>
                <TextField.Root
                  type="number"
                  value={loadForm.threshold || 80}
                  onChange={(e) => setLoadForm({ ...loadForm, threshold: Number(e.target.value) })}
                  mt="1"
                />
              </label>
              <label style={{ flex: 1 }}>
                <Text size="2" weight="bold">达标率</Text>
                <TextField.Root
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={loadForm.ratio || 0.8}
                  onChange={(e) => setLoadForm({ ...loadForm, ratio: Number(e.target.value) })}
                  mt="1"
                />
                <Text size="1" color="gray">
                  监测窗口内超标采样比例，0.8 表示 80% 采样超标时触发
                </Text>
              </label>
            </Flex>
            <label>
              <Text size="2" weight="bold">监测间隔 (分钟)</Text>
              <TextField.Root
                type="number"
                min={1}
                max={240}
                value={loadForm.interval_min || 15}
                onChange={(e) => setLoadForm({ ...loadForm, interval_min: Number(e.target.value) })}
                mt="1"
              />
            </label>
            <label>
              <Flex align="center" gap="2">
                <Switch
                  checked={loadForm.all_clients === true}
                  onCheckedChange={(v) => setLoadForm({ ...loadForm, all_clients: v })}
                />
                <Text size="2" weight="bold">应用到所有服务器</Text>
              </Flex>
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setLoadDialogOpen(false)}>取消</Button>
            <Button onClick={saveLoadNotification}>{editingLoad ? '保存' : '创建'}</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
