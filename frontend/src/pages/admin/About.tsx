import { useState, useEffect } from 'react';
import { Flex, Card, Text, Heading, Badge, Grid, Box, Button, TextField, Tabs } from '@radix-ui/themes';
import { Activity, Bell, Cloud, Code2, Database, Github, Monitor, ShieldCheck, Server, Zap } from 'lucide-react';
import { formatAppVersion } from '../../utils/version';
import { useApi } from '../../contexts/AuthContext';

interface VersionInfo {
  version: string;
  name: string;
  hash: string;
}

interface UpdateCheckInfo {
  current_version: string;
  latest_version: string;
  current_commit: string;
  latest_commit: string;
  has_update: boolean;
  source_url: string;
  upgrade_url: string | null;
  repository_url: string | null;
  title: string;
  body: string;
  published_at: string;
  error?: string;
  detail?: string;
}

interface UpdateSettings {
  update_repository_url: string;
}

const stackItems = [
  { icon: Cloud, title: 'Cloudflare Workers', text: 'API 入口、前端托管与部署运行时' },
  { icon: Zap, title: 'Durable Objects', text: '实时数据、WebSocket 与在线状态协调' },
  { icon: Database, title: 'Supabase HTTP API', text: '配置、历史记录、备份与审计日志' },
  { icon: Code2, title: 'Hono + TypeScript', text: 'Worker 后端路由、鉴权与接口校验' },
  { icon: Monitor, title: 'React + Radix UI', text: '后台管理、公开状态页与图表展示' },
  { icon: Server, title: 'Go Agent', text: 'VPS 端采集、Ping、网站探测与上报' },
];

const coreFeatures = [
  '实时 CPU / 内存 / 磁盘 / 网络 / 温度监控',
  '总流量持久统计，重启后继续累计',
  '自定义 Ping 任务与延迟图表',
  '网站监控，支持 Worker / Agent 检测',
  '公开状态页，支持 monitor / next 主题',
  '节点标签、分组、排序、对游客隐藏',
];

const opsFeatures = [
  'Telegram / Email 告警',
  '离线、到期、负载阈值通知',
  '后台一键安装命令生成',
  '站点 Logo 上传与主题配置',
  '加密备份与恢复',
  '审计日志、容量估算、健康检查',
];

function FeatureList({ items }: { items: string[] }) {
  return (
    <Grid columns={{ initial: '1', sm: '2' }} gap="2" mt="3">
      {items.map((feature) => (
        <Flex key={feature} align="start" gap="2" className="admin-about-feature-item">
          <Box className="admin-about-dot" />
          <Text size="2">{feature}</Text>
        </Flex>
      ))}
    </Grid>
  );
}

export default function AdminAbout() {
  const apiFetch = useApi();
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckInfo | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings>({
    update_repository_url: '',
  });
  const [updateSettingsSaving, setUpdateSettingsSaving] = useState(false);
  const [updateSettingsMessage, setUpdateSettingsMessage] = useState('');

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  const loadUpdateSettings = () => {
    apiFetch('/admin/settings?scope=update')
      .then((data) => data as UpdateSettings)
      .then((data) => setUpdateSettings({
        update_repository_url: data.update_repository_url || '',
      }))
      .catch(() => {});
  };

  const loadUpdateInfo = (refresh = false) => {
    setUpdateLoading(true);
    apiFetch(`/admin/update-check${refresh ? '?refresh=1' : ''}`)
      .then((data) => data as UpdateCheckInfo)
      .then(setUpdateInfo)
      .catch((error) => setUpdateInfo({
        current_version: formatAppVersion(version?.version),
        latest_version: '',
        current_commit: version?.hash || '',
        latest_commit: '',
        has_update: false,
        source_url: '',
        upgrade_url: null,
        repository_url: null,
        title: '',
        body: '',
        published_at: '',
        error: error?.error || '检查失败',
        detail: error?.detail || '',
      }))
      .finally(() => setUpdateLoading(false));
  };

  useEffect(() => {
    loadUpdateSettings();
    loadUpdateInfo();
  }, []);

  const saveUpdateSettings = () => {
    setUpdateSettingsSaving(true);
    setUpdateSettingsMessage('');
    apiFetch('/admin/settings', {
      method: 'POST',
      body: JSON.stringify(updateSettings),
    })
      .then(() => {
        setUpdateSettingsMessage('已保存');
        loadUpdateInfo(true);
      })
      .catch((error) => setUpdateSettingsMessage(error?.message || '保存失败'))
      .finally(() => setUpdateSettingsSaving(false));
  };

  const currentVersion = updateInfo?.current_version || formatAppVersion(version?.version);
  const displayedHash = version?.hash && version.hash !== 'dev' ? version.hash : '未记录';
  const currentCommit = updateInfo?.current_commit || displayedHash;
  const openExternal = (url: string | null | undefined) => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="admin-about-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Monitor size={20} />
          <Heading size="5">关于</Heading>
        </Flex>
      </Flex>

      <Tabs.Root defaultValue="overview" className="admin-about-tabs">
        <Tabs.List>
          <Tabs.Trigger value="overview">项目概览</Tabs.Trigger>
          <Tabs.Trigger value="updates">版本更新</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="overview">
          <Flex direction="column" gap="3" mt="3">
            <Card className="admin-about-card admin-about-card-full">
              <Flex className="admin-about-hero" align="center" gap="4">
                <Box className="admin-about-logo">
                  <Monitor size={40} color="white" />
                </Box>
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Heading size="6">CF VPS Monitor</Heading>
                  <Text as="p" size="2" color="gray" mt="1">基于 Cloudflare Workers 的轻量 VPS 探针与公开状态页</Text>
                  <Flex gap="2" wrap="wrap" mt="2">
                    <Badge size="2" color="blue">{formatAppVersion(version?.version)}</Badge>
                    <Badge size="2" variant="soft" color="gray">{displayedHash}</Badge>
                    <Badge size="2" variant="soft" color="green">Cloudflare Workers</Badge>
                  </Flex>
                </Box>
                <Button variant="soft" onClick={() => openExternal('https://github.com/kadidalax/cf-vps-monitor')} aria-label="GitHub">
                  <Github size={16} />
                </Button>
              </Flex>
            </Card>

            <Card className="admin-about-card admin-about-card-full">
              <Heading size="3">技术架构</Heading>
              <Grid columns={{ initial: '1', sm: '2', lg: '3' }} gap="3" mt="3">
                {stackItems.map(({ icon: Icon, title, text }) => (
                  <Flex key={title} className="admin-about-stack-item" gap="2" align="center">
                    <Box className="admin-about-stack-icon"><Icon size={16} /></Box>
                    <Box style={{ minWidth: 0 }}>
                      <Text as="div" size="2" weight="bold">{title}</Text>
                      <Text as="div" size="1" color="gray">{text}</Text>
                    </Box>
                  </Flex>
                ))}
              </Grid>
            </Card>

            <Grid columns={{ initial: '1', md: '2' }} gap="3">
              <Card className="admin-about-card admin-about-card-full">
                <Flex align="center" gap="2">
                  <Activity size={18} color="var(--accent-9)" />
                  <Heading size="3">核心能力</Heading>
                </Flex>
                <FeatureList items={coreFeatures} />
              </Card>

              <Card className="admin-about-card admin-about-card-full">
                <Flex align="center" gap="2">
                  <Bell size={18} color="var(--accent-9)" />
                  <Heading size="3">运维能力</Heading>
                </Flex>
                <FeatureList items={opsFeatures} />
              </Card>
            </Grid>

            <Card className="admin-about-card admin-about-card-full">
              <Flex align="center" gap="2" mb="2">
                <ShieldCheck size={18} color="var(--accent-9)" />
                <Heading size="3">项目定位</Heading>
              </Flex>
              <Text size="2" color="gray" className="admin-about-position">
                面向个人和小团队的自托管 VPS 监控面板，优先追求轻量部署、公开状态展示、低维护成本和 Cloudflare 免费生态友好。
                适合轻量 VPS 探针、公开服务状态页、节点资产管理、基础告警与日常运维巡检。
              </Text>
            </Card>
          </Flex>
        </Tabs.Content>

        <Tabs.Content value="updates">
          <Grid className="admin-about-update-grid" columns={{ initial: '1', lg: '2' }} gap="3" mt="3">
            <Card className="admin-about-card admin-about-card-full">
              <Flex direction="column" gap="3" className="admin-about-update-card">
                <Box>
                  <Heading size="3">更新设置</Heading>
                  <Text as="p" size="2" color="gray" mt="1">检测方式：推送编码。官方仓库最新编码不同即视为有更新。</Text>
                </Box>

                <Text size="1" className="admin-about-warning">
                  当前只支持 Fork 仓库通过 GitHub Sync fork 同步更新。一键部署自动创建的仓库不保证包含更新工作流，已不再作为后台更新方式。
                </Text>

                <Box>
                  <Text as="label" size="2" weight="medium">你的部署仓库地址</Text>
                  <TextField.Root
                    mt="1"
                    value={updateSettings.update_repository_url}
                    placeholder="https://github.com/用户名/仓库名"
                    onChange={(event) => setUpdateSettings((current) => ({
                      ...current,
                      update_repository_url: event.target.value,
                    }))}
                  />
                  <Text as="p" size="1" color="gray" mt="1">
                    填写当前 Worker 连接并部署的 Fork 仓库地址，不是官方更新源。
                  </Text>
                </Box>

                <Flex align="center" justify="between" gap="3" wrap="wrap" mt="auto">
                  <Text size="1" color="gray">更新源：kadidalax/cf-vps-monitor/main</Text>
                  <Flex align="center" gap="2">
                    {updateSettingsMessage && (
                      <Text size="1" color={updateSettingsMessage === '已保存' ? 'green' : 'red'}>{updateSettingsMessage}</Text>
                    )}
                    <Button size="2" variant="soft" onClick={saveUpdateSettings} disabled={updateSettingsSaving}>
                      {updateSettingsSaving ? '保存中...' : '保存设置'}
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </Card>

            <Card className="admin-about-card admin-about-card-full">
              <Flex direction="column" gap="3" className="admin-about-update-card">
                <Flex align="center" justify="between" gap="3">
                  <Heading size="3">检测结果</Heading>
                  {updateInfo?.has_update && <Badge color="orange">有更新</Badge>}
                </Flex>

                {updateLoading && <Text size="2" color="gray">正在检查更新...</Text>}
                {updateInfo?.error && (
                  <Text size="2" color="red">
                    {updateInfo.error}{updateInfo.detail ? `：${updateInfo.detail}` : ''}
                  </Text>
                )}

                <Grid columns={{ initial: '1', sm: '2' }} gap="3">
                  <Box className="admin-about-update-metric">
                    <Text size="1" color="gray">当前版本</Text>
                    <Text as="div" size="3" weight="bold">{currentVersion}</Text>
                  </Box>
                  <Box className="admin-about-update-metric">
                    <Text size="1" color="gray">最新版本</Text>
                    <Text as="div" size="3" weight="bold">{updateInfo?.latest_version || '-'}</Text>
                  </Box>
                  <Box className="admin-about-update-metric">
                    <Text size="1" color="gray">当前推送编码</Text>
                    <Text as="div" size="3" weight="bold">{currentCommit}</Text>
                  </Box>
                  <Box className="admin-about-update-metric">
                    <Text size="1" color="gray">最新推送编码</Text>
                    <Text as="div" size="3" weight="bold">{updateInfo?.latest_commit || '-'}</Text>
                  </Box>
                </Grid>

                {updateInfo?.published_at && (
                  <Text size="1" color="gray">提交时间：{new Date(updateInfo.published_at).toLocaleString()}</Text>
                )}
                {updateInfo?.body && (
                  <Text size="2" color="gray" className="admin-about-commit-message">
                    {updateInfo.body.slice(0, 1200)}
                  </Text>
                )}
                {updateInfo && !updateInfo.upgrade_url && !updateInfo.error && (
                  <Text size="2" color="orange">请先保存你的 Fork 部署仓库地址，才能生成更新入口。</Text>
                )}

                <Flex gap="2" wrap="wrap" mt="auto">
                  <Button variant="soft" onClick={() => loadUpdateInfo(true)} disabled={updateLoading}>重新检测</Button>
                  <Button variant="soft" disabled={!updateInfo?.source_url} onClick={() => openExternal(updateInfo?.source_url)}>查看更新</Button>
                  <Button disabled={!updateInfo?.upgrade_url || !updateInfo?.has_update} onClick={() => openExternal(updateInfo?.upgrade_url)}>前往同步 Fork</Button>
                </Flex>
              </Flex>
            </Card>
          </Grid>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
