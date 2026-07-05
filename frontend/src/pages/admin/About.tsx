import { useState, useEffect } from 'react';
import { Flex, Card, Text, Heading, Badge, Grid, Box, Separator, Button } from '@radix-ui/themes';
import { Monitor, Cloud, Database, Zap } from 'lucide-react';
import { formatAppVersion } from '../../utils/version';

interface VersionInfo {
  version: string;
  name: string;
  hash: string;
}

interface UpdateCheckInfo {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  release_url: string;
  actions_url: string | null;
  workflow_configured: boolean;
  title: string;
  body: string;
  published_at: string;
  error?: string;
  detail?: string;
}

export default function AdminAbout() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckInfo | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  const loadUpdateInfo = (refresh = false) => {
    setUpdateLoading(true);
    fetch(`/api/admin/update-check${refresh ? '?refresh=1' : ''}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw data;
        setUpdateInfo(data);
      })
      .catch((error) => setUpdateInfo({
        current_version: formatAppVersion(version?.version),
        latest_version: '',
        has_update: false,
        release_url: '',
        actions_url: null,
        workflow_configured: false,
        title: '',
        body: '',
        published_at: '',
        error: error?.error || '检查失败',
        detail: error?.detail || '',
      }))
      .finally(() => setUpdateLoading(false));
  };

  useEffect(() => {
    loadUpdateInfo();
  }, []);

  const currentVersion = updateInfo?.current_version || formatAppVersion(version?.version);
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

      <Card className="admin-about-card">
        <Flex direction="column" align="center" gap="3" mb="4">
          <Box style={{
            width: 80, height: 80, borderRadius: '20px',
            background: 'linear-gradient(135deg, var(--accent-9), var(--accent-10))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Monitor size={40} color="white" />
          </Box>
          <Heading size="6">CF VPS Monitor</Heading>
          <Text size="2" color="gray">基于 Cloudflare 的服务器监控探针</Text>
          <Flex gap="2">
            <Badge size="2" color="blue">{formatAppVersion(version?.version)}</Badge>
            {version?.hash && <Badge size="2" variant="soft" color="gray">{version.hash.slice(0, 7)}</Badge>}
          </Flex>
        </Flex>

        <Separator size="4" mb="4" />

        <Flex direction="column" gap="3" mb="4">
          <Flex align="center" justify="between" gap="3">
            <Heading size="3">系统更新</Heading>
            {updateInfo?.has_update && <Badge color="orange">有更新</Badge>}
          </Flex>
          <Text size="2" color="gray">当前版本：{currentVersion}</Text>
          {updateLoading && <Text size="2" color="gray">正在检查更新...</Text>}
          {updateInfo?.error && (
            <Text size="2" color="red">
              {updateInfo.error}{updateInfo.detail ? `：${updateInfo.detail}` : ''}
            </Text>
          )}
          {updateInfo && !updateInfo.error && (
            <>
              <Text size="2">最新版本：{updateInfo.latest_version}</Text>
              {updateInfo.published_at && (
                <Text size="1" color="gray">发布时间：{new Date(updateInfo.published_at).toLocaleString()}</Text>
              )}
              {updateInfo.body && (
                <Text size="2" color="gray" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
                  {updateInfo.body.slice(0, 1200)}
                </Text>
              )}
              {!updateInfo.workflow_configured && (
                <Text size="2" color="orange">未配置 GITHUB_REPOSITORY_URL，无法生成你的仓库升级入口。</Text>
              )}
            </>
          )}
          <Flex gap="2" wrap="wrap">
            <Button variant="soft" onClick={() => loadUpdateInfo(true)} disabled={updateLoading}>重新检查</Button>
            <Button variant="soft" disabled={!updateInfo?.release_url} onClick={() => openExternal(updateInfo?.release_url)}>查看 Release</Button>
            <Button disabled={!updateInfo?.workflow_configured || !updateInfo?.has_update} onClick={() => openExternal(updateInfo?.actions_url)}>立即升级</Button>
          </Flex>
        </Flex>

        <Separator size="4" mb="4" />

        <Grid columns="2" gap="4" mb="4">
          <Flex align="center" gap="2">
            <Cloud size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">Cloudflare Workers</Text>
              <Text size="1" color="gray">API 服务 + 前端托管</Text>
            </Flex>
          </Flex>
          <Flex align="center" gap="2">
            <Database size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">Supabase HTTP API</Text>
              <Text size="1" color="gray">持久化数据库</Text>
            </Flex>
          </Flex>
          <Flex align="center" gap="2">
            <Zap size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">Durable Objects</Text>
              <Text size="1" color="gray">WebSocket 实时数据</Text>
            </Flex>
          </Flex>
          <Flex align="center" gap="2">
            <Monitor size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">React + Radix UI</Text>
              <Text size="1" color="gray">前端界面 + Recharts</Text>
            </Flex>
          </Flex>
        </Grid>

        <Separator size="4" mb="4" />

        <Heading size="3" mb="3">特性</Heading>
        <Grid columns="2" gap="2" mb="4">
          {[
            '实时服务器资源监控',
            'CPU/内存/磁盘/网络/温度',
            '自定义 Ping 监测',
            '离线通知 (Telegram)',
            '负载阈值通知',
            '服务器分组/排序/隐藏',
            '数据备份与恢复',
            '审计日志记录',
            '暗色/亮色主题',
            '响应式设计',
            '键盘快捷键',
            '全局错误捕获',
          ].map((feature, i) => (
            <Flex key={i} align="center" gap="2">
              <Box style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--accent-9)', flexShrink: 0 }} />
              <Text size="2">{feature}</Text>
            </Flex>
          ))}
        </Grid>

        <Separator size="4" mb="4" />

        <Heading size="3" mb="3">项目定位</Heading>
        <Text size="2" color="gray">
          CF VPS Monitor 是一个独立的 Cloudflare Workers 服务器监控面板，
          面向轻量 VPS 探针、公开状态页和自托管运维场景。
        </Text>
      </Card>
    </div>
  );
}
