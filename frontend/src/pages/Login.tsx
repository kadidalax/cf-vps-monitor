import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Flex, Card, Text, TextField, Button, Heading, Box, Separator } from '@radix-ui/themes';
import { LogIn, Eye, EyeOff, KeyRound, UserPlus } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { hasLocalDisplayThemePreference, useDisplayTheme } from '../contexts/DisplayThemeContext';
import { toast } from 'sonner';
import Loading from '../components/Loading';
import { refreshActiveThemeStylesheet } from '../utils/activeThemeStylesheet';
import { normalizeDisplayTheme } from '../utils/displayTheme';
import { fetchPublicSettings } from '../utils/publicSettings';
import { formatAppVersion } from '../utils/version';

type RecoveryStatus = {
  admin_present: boolean;
  recoverable: boolean;
};

export default function Login() {
  const { login, isAuthenticated, authLoading } = useAuth();
  const { setDisplayThemeFromSettings } = useDisplayTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const redirectTo = from?.startsWith('/admin') ? from : '/admin';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState('dev');
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryUsername, setRecoveryUsername] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [showRecoveryPassword, setShowRecoveryPassword] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  React.useEffect(() => {
    if (isAuthenticated) navigate(redirectTo, { replace: true });
  }, [isAuthenticated, navigate, redirectTo]);

  React.useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then((data) => {
        if (data.version) setVersion(formatAppVersion(data.version));
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    refreshActiveThemeStylesheet();
    fetchPublicSettings({ force: true })
      .then((data) => {
        if (!hasLocalDisplayThemePreference()) {
          setDisplayThemeFromSettings(normalizeDisplayTheme(data.active_theme));
        }
      })
      .catch(() => {});
  }, [setDisplayThemeFromSettings]);

  React.useEffect(() => {
    fetch('/api/admin/recovery/status')
      .then((r) => r.ok ? r.json() : null)
      .then((data: RecoveryStatus | null) => {
        if (!data) return;
        setRecoveryStatus(data);
        setRecoveryMode(!data.admin_present);
      })
      .catch(() => {});
  }, []);

  if (authLoading) return <Loading />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      toast.error('请输入用户名和密码');
      return;
    }

    setLoading(true);
    const error = await login(username, password);
    setLoading(false);

    if (error) {
      toast.error(error);
    } else {
      toast.success('登录成功');
      navigate(redirectTo, { replace: true });
    }
  };

  const handleRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const needsServiceRoleKey = recoveryStatus?.admin_present === true;
    if ((needsServiceRoleKey && !recoveryKey) || !recoveryUsername || !recoveryPassword) {
      toast.error(needsServiceRoleKey ? '请填写 service_role key、用户名和新密码' : '请填写用户名和密码');
      return;
    }

    setRecoveryLoading(true);
    try {
      const payload: Record<string, string> = {
        username: recoveryUsername,
        password: recoveryPassword,
      };
      if (needsServiceRoleKey) payload.supabase_service_role_key = recoveryKey;
      const response = await fetch('/api/admin/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data.error || '重置失败');
        return;
      }
      toast.success(data.mode === 'created' ? '管理员已创建' : '管理员密码已重置');
      setUsername(recoveryUsername);
      setPassword('');
      setRecoveryPassword('');
      setRecoveryKey('');
      setRecoveryStatus({ admin_present: true, recoverable: true });
      setRecoveryMode(false);
    } catch {
      toast.error('请求失败，请稍后重试');
    } finally {
      setRecoveryLoading(false);
    }
  };

  const recoveryTitle = recoveryStatus?.admin_present ? '重置管理员' : '创建管理员';
  const needsServiceRoleKey = recoveryStatus?.admin_present === true;

  return (
    <div className="login-page">
      <Card className="login-card" style={{ padding: '36px 32px' }}>
        <Flex direction="column" align="center" gap="2" mb="5">
          <Box className="login-logo">
            <img src="/app-icon.png" alt="" />
          </Box>
          <Heading size="6" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', fontWeight: 700 }}>
            CF VPS Monitor
          </Heading>
          <Text size="2" color="gray" style={{ marginTop: '-2px' }}>
            Cloudflare 服务器监控探针
          </Text>
        </Flex>

        <Separator size="4" mb="4" />

        {!recoveryMode && (
        <form onSubmit={handleSubmit}>
          <Flex direction="column" gap="4">
            <label htmlFor="login-username">
              <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                用户名
              </Text>
              <TextField.Root
                id="login-username"
                size="3"
                placeholder="请输入用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                style={{ width: '100%' }}
              />
            </label>

            <label htmlFor="login-password">
              <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                密码
              </Text>
              <div style={{ position: 'relative' }}>
                <TextField.Root
                  id="login-password"
                  size="3"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  style={{ width: '100%', paddingRight: 40 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
                    width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    color: 'var(--gray-9)',
                  }}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            <Button
              type="submit"
              size="3"
              disabled={loading}
              style={{
                marginTop: 8,
                fontWeight: 600,
                height: 44,
                fontSize: '15px',
              }}
            >
              <LogIn size={18} />
              {loading ? '登录中...' : '登录'}
            </Button>
          </Flex>
        </form>
        )}

        {recoveryMode && (
          <form onSubmit={handleRecoverySubmit}>
            <Flex direction="column" gap="4">
              {needsServiceRoleKey && <label htmlFor="recovery-service-role-key">
                <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                  Supabase service_role key
                </Text>
                <TextField.Root
                  id="recovery-service-role-key"
                  size="3"
                  type="password"
                  placeholder="请输入 Supabase service_role key"
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  autoComplete="off"
                  autoFocus
                  style={{ width: '100%' }}
                />
              </label>}

              <label htmlFor="recovery-username">
                <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                  用户名
                </Text>
                <TextField.Root
                  id="recovery-username"
                  size="3"
                  placeholder="请输入新用户名"
                  value={recoveryUsername}
                  onChange={(e) => setRecoveryUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus={!needsServiceRoleKey}
                  style={{ width: '100%' }}
                />
              </label>

              <label htmlFor="recovery-password">
                <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                  新密码
                </Text>
                <div style={{ position: 'relative' }}>
                  <TextField.Root
                    id="recovery-password"
                    size="3"
                    type={showRecoveryPassword ? 'text' : 'password'}
                    placeholder="请输入新密码"
                    value={recoveryPassword}
                    onChange={(e) => setRecoveryPassword(e.target.value)}
                    autoComplete="new-password"
                    style={{ width: '100%', paddingRight: 40 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowRecoveryPassword(!showRecoveryPassword)}
                    style={{
                      position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
                      width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      color: 'var(--gray-9)',
                    }}
                    aria-label={showRecoveryPassword ? '隐藏密码' : '显示密码'}
                  >
                    {showRecoveryPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>

              <Button
                type="submit"
                size="3"
                disabled={recoveryLoading || recoveryStatus?.recoverable === false}
                style={{
                  marginTop: 8,
                  fontWeight: 600,
                  height: 44,
                  fontSize: '15px',
                }}
              >
                {recoveryStatus?.admin_present ? <KeyRound size={18} /> : <UserPlus size={18} />}
                {recoveryLoading ? '处理中...' : recoveryTitle}
              </Button>
            </Flex>
          </form>
        )}

        <Flex justify="center" mt="4">
          <Button
            type="button"
            variant="ghost"
            size="2"
            onClick={() => setRecoveryMode(!recoveryMode)}
          >
            {recoveryMode ? '返回登录' : '忘记密码'}
          </Button>
        </Flex>

      </Card>

      <Text size="1" color="gray" style={{ position: 'fixed', bottom: 16, textAlign: 'center' }}>
        CF VPS Monitor {version} &middot; Powered by Cloudflare Workers
      </Text>
    </div>
  );
}
