import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Button, Card, Flex, Heading, Separator, Text, TextField } from '@radix-ui/themes';
import { CheckCircle2, Database, KeyRound, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

type InitInfo = {
  ok: boolean;
  project_ref?: string | null;
  migration_count?: number;
};

type InitResult = {
  success?: boolean;
  project_ref?: string;
  total?: number;
  applied?: number;
  skipped?: number;
  results?: Array<{
    version: string;
    name: string;
    status: 'applied' | 'skipped';
  }>;
  error?: string;
};

async function readJson(response: Response): Promise<InitResult> {
  return response.json().catch(() => ({ error: response.statusText }));
}

export default function DbInit() {
  const [info, setInfo] = React.useState<InitInfo | null>(null);
  const [token, setToken] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<InitResult | null>(null);

  React.useEffect(() => {
    fetch('/api/setup/database/init')
      .then((response) => response.json())
      .then(setInfo)
      .catch(() => setInfo({ ok: false }));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token.trim()) {
      toast.error('请输入 Supabase Access Token');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const response = await fetch('/api/setup/database/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token.trim() }),
      });
      const body = await readJson(response);
      setResult(body);
      if (!response.ok || !body.success) throw new Error(body.error || `HTTP ${response.status}`);
      setToken('');
      toast.success('数据库初始化完成');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '初始化失败');
    } finally {
      setLoading(false);
    }
  }

  const done = Boolean(result?.success);

  return (
    <div className="login-page db-init-page">
      <Card className="login-card db-init-card" style={{ padding: '32px' }}>
        <Flex direction="column" align="center" gap="2" mb="5">
          <Box className="login-logo">
            <Database size={32} color="white" />
          </Box>
          <Heading size="6">初始化数据库</Heading>
          <Text size="2" color="gray" align="center">
            输入 1 小时有效的 Supabase Access Token，一键创建所需表、索引和 RPC。
          </Text>
        </Flex>

        <Separator size="4" mb="4" />

        <Flex className="db-init-meta" gap="2" wrap="wrap" mb="4">
          <Badge color={info?.ok ? 'green' : 'red'} variant="soft">
            项目: {info?.project_ref || '未识别'}
          </Badge>
          <Badge color="gray" variant="soft">
            迁移: {info?.migration_count ?? '-'}
          </Badge>
        </Flex>

        <form onSubmit={submit}>
          <Flex direction="column" gap="4">
            <label htmlFor="supabase-access-token">
              <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                Supabase Access Token
              </Text>
              <TextField.Root
                id="supabase-access-token"
                size="3"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sbp_xxx"
                autoComplete="off"
                disabled={loading}
              >
                <TextField.Slot>
                  <KeyRound size={16} />
                </TextField.Slot>
              </TextField.Root>
            </label>

            <Button type="submit" size="3" disabled={loading || !info?.ok} style={{ height: 44, fontWeight: 700 }}>
              {loading ? <Loader2 className="db-init-spin" size={18} /> : <Database size={18} />}
              {loading ? '正在初始化...' : '一键初始化数据库'}
            </Button>
          </Flex>
        </form>

        {result && (
          <Box className={`db-init-result ${done ? 'is-success' : 'is-error'}`} mt="4">
            <Flex align="center" gap="2" mb="2">
              {done ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              <Text size="2" weight="bold">
                {done ? `完成：新执行 ${result.applied ?? 0} 个，跳过 ${result.skipped ?? 0} 个` : '初始化失败'}
              </Text>
            </Flex>
            {result.error && <Text size="2">{result.error}</Text>}
            {done && (
              <Flex direction="column" gap="1" className="db-init-log">
                {(result.results || []).map((item) => (
                  <Text size="1" key={item.version}>
                    {item.status === 'applied' ? '执行' : '跳过'} {item.version}
                  </Text>
                ))}
              </Flex>
            )}
          </Box>
        )}

        {done && (
          <Button asChild size="3" variant="soft" mt="4" style={{ width: '100%' }}>
            <Link to="/admin/login">进入后台登录</Link>
          </Button>
        )}
      </Card>
    </div>
  );
}
