import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Flex, Card, Text, TextField, Button, Heading, Box, Separator, SegmentedControl } from '@radix-ui/themes';
import { ArrowLeft, LogIn, Eye, EyeOff, KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { hasLocalDisplayThemePreference, useDisplayTheme } from '../contexts/DisplayThemeContext';
import { toast } from 'sonner';
import Loading from '../components/Loading';
import { refreshActiveThemeStylesheet } from '../utils/activeThemeStylesheet';
import { normalizeDisplayTheme } from '../utils/displayTheme';
import { fetchPublicSettings } from '../utils/publicSettings';
import { formatAppVersion } from '../utils/version';
import { normalizeMfaCode, type MfaMethod } from '../utils/mfa';

type RecoveryStatus = {
  admin_present: boolean;
  recoverable: boolean;
};

function safeLogoUrl(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin === window.location.origin || url.protocol === 'https:') return url.toString();
  } catch {
    return '';
  }
  return '';
}

export default function Login() {
  const { login, completeMfaLogin, isAuthenticated, authLoading } = useAuth();
  const { setDisplayThemeFromSettings } = useDisplayTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const redirectTo = from?.startsWith('/admin') ? from : '/admin';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState('');
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [version, setVersion] = useState('dev');
  const [siteLogoUrl, setSiteLogoUrl] = useState('');
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
        setSiteLogoUrl(safeLogoUrl(data.site_logo_url));
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
    const result = await login(username, password);
    setLoading(false);

    if (result.kind === 'error') {
      toast.error(result.error);
      return;
    }
    if (result.kind === 'mfa_required') {
      setMfaChallenge(result.challenge);
      setMfaMethod(result.methods.includes('totp') ? 'totp' : result.methods[0] || 'totp');
      setMfaCode('');
      setPassword('');
      return;
    }
    toast.success('登录成功');
    navigate(redirectTo, { replace: true });
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = normalizeMfaCode(mfaCode, mfaMethod);
    if (!code) {
      toast.error(mfaMethod === 'totp' ? '请输入 6 位动态验证码' : '恢复码格式无效');
      return;
    }

    setLoading(true);
    const result = await completeMfaLogin(mfaChallenge, mfaMethod, code);
    setLoading(false);
    if (result.kind === 'error') {
      toast.error(result.error);
      if (/失效|重新登录/.test(result.error)) {
        setMfaChallenge('');
        setMfaCode('');
      }
      return;
    }
    if (result.kind !== 'success') {
      toast.error('登录验证响应无效');
      return;
    }
    toast.success('登录成功');
    navigate(redirectTo, { replace: true });
  };

  const handleRecoverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const needsSecretKey = recoveryStatus?.admin_present === true;
    if ((needsSecretKey && !recoveryKey) || !recoveryUsername || !recoveryPassword) {
      toast.error(needsSecretKey ? '请填写 Supabase Secret key、用户名和新密码' : '请填写用户名和密码');
      return;
    }

    setRecoveryLoading(true);
    try {
      const payload: Record<string, string> = {
        username: recoveryUsername,
        password: recoveryPassword,
      };
      if (needsSecretKey) payload.supabase_secret_key = recoveryKey;
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
  const needsSecretKey = recoveryStatus?.admin_present === true;

  return (
    <div className="login-page">
      <Card className="login-card" style={{ padding: '36px 32px' }}>
        <Flex direction="column" align="center" gap="2" mb="5">
          <Box className="login-logo">
            <img src={siteLogoUrl || '/app-icon.png'} alt="" />
          </Box>
          <Heading size="6" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', fontWeight: 700 }}>
            CF VPS Monitor
          </Heading>
          <Text size="2" color="gray" style={{ marginTop: '-2px' }}>
            Cloudflare 服务器监控探针
          </Text>
        </Flex>

        <Separator size="4" mb="4" />

        {!recoveryMode && !mfaChallenge && (
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

        {!recoveryMode && mfaChallenge && (
          <form onSubmit={handleMfaSubmit}>
            <Flex direction="column" gap="4">
              <Flex align="center" gap="2">
                <ShieldCheck size={18} />
                <Text size="3" weight="bold">双重身份验证</Text>
              </Flex>
              <Text size="2" color="gray">请输入验证器生成的动态验证码，或使用一个恢复码。</Text>
              <SegmentedControl.Root
                value={mfaMethod}
                onValueChange={(value) => {
                  setMfaMethod(value as MfaMethod);
                  setMfaCode('');
                }}
              >
                <SegmentedControl.Item value="totp">动态验证码</SegmentedControl.Item>
                <SegmentedControl.Item value="recovery_code">恢复码</SegmentedControl.Item>
              </SegmentedControl.Root>
              <label htmlFor="login-mfa-code">
                <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                  {mfaMethod === 'totp' ? '6 位验证码' : '一次性恢复码'}
                </Text>
                <TextField.Root
                  id="login-mfa-code"
                  size="3"
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  placeholder={mfaMethod === 'totp' ? '000000' : 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX'}
                  autoComplete="one-time-code"
                  inputMode={mfaMethod === 'totp' ? 'numeric' : 'text'}
                  autoFocus
                  style={{ width: '100%' }}
                />
              </label>
              <Button type="submit" size="3" disabled={loading} style={{ height: 44 }}>
                <KeyRound size={18} />{loading ? '验证中...' : '验证并登录'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMfaChallenge('');
                  setMfaCode('');
                }}
              >
                <ArrowLeft size={16} />返回密码登录
              </Button>
            </Flex>
          </form>
        )}
        {recoveryMode && (
          <form onSubmit={handleRecoverySubmit}>
            <Flex direction="column" gap="4">
              {needsSecretKey && <label htmlFor="recovery-secret-key">
                <Text size="2" weight="bold" style={{ marginBottom: 6, display: 'inline-block' }}>
                  Supabase Secret key
                </Text>
                <TextField.Root
                  id="recovery-secret-key"
                  size="3"
                  type="password"
                  placeholder="请输入 Supabase Secret key"
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
                  autoFocus={!needsSecretKey}
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
            onClick={() => {
              setRecoveryMode(!recoveryMode);
              setMfaChallenge('');
              setMfaCode('');
            }}
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
