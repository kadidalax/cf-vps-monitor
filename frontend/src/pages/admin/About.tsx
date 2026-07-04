import { useState, useEffect } from 'react';
import { Flex, Card, Text, Heading, Badge, Grid, Box, Separator } from '@radix-ui/themes';
import { Monitor, Cloud, Database, Zap } from 'lucide-react';
import { formatAppVersion } from '../../utils/version';

interface VersionInfo {
  version: string;
  name: string;
  hash: string;
}

export default function AdminAbout() {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

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
