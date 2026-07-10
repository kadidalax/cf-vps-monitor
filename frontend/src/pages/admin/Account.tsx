import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Heading,
  Tabs,
  Text,
  TextField,
} from '@radix-ui/themes';
import {
  Copy,
  Download,
  KeyRound,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldOff,
  User,
} from 'lucide-react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { useApi, useAuth } from '../../contexts/AuthContext';
import { downloadRecoveryCodes, formatRecoveryCodesText, normalizeMfaCode, requestMfaStepUp } from '../../utils/mfa';

type AccountTab = 'username' | 'password' | 'security';

type MfaStatus = {
  enabled: boolean;
  enabled_at: string | null;
  recovery_codes_remaining: number;
};

type MfaSetup = {
  setup_token: string;
  secret: string;
  uri: string;
};

export default function AdminAccount() {
  const apiFetch = useApi();
  const { user, updateUser } = useAuth();
  const [activeTab, setActiveTab] = useState<AccountTab>('username');
  const [username, setUsername] = useState(user?.username || '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [setupPassword, setSetupPassword] = useState('');
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [showRebind, setShowRebind] = useState(false);
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);

  useEffect(() => {
    setUsername(user?.username || '');
  }, [user?.username]);

  const loadMfaStatus = useCallback(async () => {
    try {
      setMfaStatus(await apiFetch('/admin/account/mfa'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法读取双重身份验证状态');
    }
  }, [apiFetch]);

  useEffect(() => {
    if (activeTab === 'security' && !mfaStatus) void loadMfaStatus();
  }, [activeTab, loadMfaStatus, mfaStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!setup?.uri) {
      setQrDataUrl('');
      return () => { cancelled = true; };
    }
    QRCode.toDataURL(setup.uri, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    }).catch(() => {
      if (!cancelled) toast.error('二维码生成失败，请手动输入密钥');
    });
    return () => { cancelled = true; };
  }, [setup?.uri]);

  const handleChangeUsername = async () => {
    const nextUsername = username.trim();
    if (!nextUsername) { toast.error('用户名不能为空'); return; }
    if (nextUsername === user?.username) { toast.info('用户名没有变化'); return; }

    setSavingUsername(true);
    try {
      const result = await apiFetch('/admin/account/username', {
        method: 'POST',
        body: JSON.stringify({ username: nextUsername }),
      });
      const nextUser = result.user || { username: nextUsername };
      updateUser(nextUser);
      setUsername(nextUser.username || nextUsername);
      toast.success('用户名修改成功');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setSavingUsername(false);
    }
  };

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) { toast.error('请填写所有字段'); return; }
    if (newPassword !== confirmPassword) { toast.error('两次输入的新密码不一致'); return; }
    if (newPassword.length < 6) { toast.error('密码长度至少 6 位'); return; }

    setSaving(true);
    try {
      await apiFetch('/admin/account/chpasswd', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      });
      toast.success('密码修改成功');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setSaving(false);
    }
  };

  const startMfaSetup = async () => {
    if (!setupPassword) { toast.error('请输入当前密码'); return; }
    setMfaLoading(true);
    try {
      const result = await apiFetch('/admin/account/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ password: setupPassword }),
      });
      setSetup(result as MfaSetup);
      setSetupCode('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法开始绑定');
    } finally {
      setMfaLoading(false);
    }
  };

  const enableMfa = async () => {
    if (!setup) return;
    const code = normalizeMfaCode(setupCode, 'totp');
    if (!code) { toast.error('请输入 6 位动态验证码'); return; }

    setMfaLoading(true);
    try {
      const result = await apiFetch('/admin/account/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ setup_token: setup.setup_token, code }),
      });
      setRecoveryCodes(Array.isArray(result.recovery_codes) ? result.recovery_codes : []);
      setSetup(null);
      setSetupPassword('');
      setSetupCode('');
      await loadMfaStatus();
      toast.success('双重身份验证已启用');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启用失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const regenerateRecoveryCodes = async () => {
    setMfaLoading(true);
    try {
      const result = await apiFetch('/admin/account/mfa/recovery-codes', { method: 'POST' });
      setRecoveryCodes(Array.isArray(result.recovery_codes) ? result.recovery_codes : []);
      await loadMfaStatus();
      toast.success('恢复码已重新生成，旧恢复码已失效');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重新生成失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const disableMfa = async () => {
    setDisableDialogOpen(false);
    if (!await requestMfaStepUp()) return;
    setMfaLoading(true);
    try {
      await apiFetch('/admin/account/mfa/disable', { method: 'POST' });
      setSetup(null);
      setSetupPassword('');
      await loadMfaStatus();
      toast.success('双重身份验证已关闭');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '关闭失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const copyRecoveryCodes = async () => {
    await navigator.clipboard.writeText(formatRecoveryCodesText(recoveryCodes, user?.username || 'admin'));
    toast.success('恢复码已复制');
  };

  return (
    <div className="admin-account-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2"><User size={20} /><Heading size="5">账户设置</Heading></Flex>
      </Flex>

      <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3" mb="3">
        <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as AccountTab)}>
          <Tabs.List className="admin-subnav-row">
            <Tabs.Trigger value="username">更改用户名</Tabs.Trigger>
            <Tabs.Trigger value="password">更改密码</Tabs.Trigger>
            <Tabs.Trigger value="security">身份验证</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </Flex>

      {activeTab === 'username' && (
        <Card className="admin-account-card">
          <Heading size="3" mb="3">更改用户名</Heading>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">用户名</Text>
              <TextField.Root className="admin-account-input" value={username} autoComplete="username" spellCheck={false} onChange={e => setUsername(e.target.value)} />
            </label>
            <Button variant="soft" onClick={handleChangeUsername} disabled={savingUsername || username.trim() === (user?.username || '')}>
              <Save size={16} />{savingUsername ? '保存中...' : '修改用户名'}
            </Button>
          </Flex>
        </Card>
      )}

      {activeTab === 'password' && (
        <Card className="admin-account-card">
          <Heading size="3" mb="3">更改密码</Heading>
          <Flex direction="column" gap="3">
            <label><Text size="2" weight="bold">旧密码</Text><TextField.Root className="admin-account-input" type="password" value={oldPassword} autoComplete="current-password" onChange={e => setOldPassword(e.target.value)} /></label>
            <label><Text size="2" weight="bold">新密码</Text><TextField.Root className="admin-account-input" type="password" value={newPassword} autoComplete="new-password" onChange={e => setNewPassword(e.target.value)} /></label>
            <label><Text size="2" weight="bold">确认新密码</Text><TextField.Root className="admin-account-input" type="password" value={confirmPassword} autoComplete="new-password" onChange={e => setConfirmPassword(e.target.value)} /></label>
            <Button onClick={handleChangePassword} disabled={saving}><Save size={16} />{saving ? '保存中...' : '修改密码'}</Button>
          </Flex>
        </Card>
      )}

      {activeTab === 'security' && (
        <Card className="admin-account-card admin-account-security-card">
          <Flex justify="between" align="center" gap="3" mb="4" wrap="wrap">
            <Box>
              <Heading size="3">TOTP 双重身份验证</Heading>
              <Text size="2" color="gray">兼容 Google Authenticator、Microsoft Authenticator、1Password 等验证器。</Text>
            </Box>
            <Badge color={mfaStatus?.enabled ? 'green' : 'gray'} size="2">
              {mfaStatus?.enabled ? '已启用' : '未启用'}
            </Badge>
          </Flex>

          {!mfaStatus ? (
            <Text color="gray">正在读取状态...</Text>
          ) : mfaStatus.enabled && !setup ? (
            <Flex direction="column" gap="4">
              <Callout.Root color="green"><Callout.Icon><ShieldCheck size={18} /></Callout.Icon><Callout.Text>账户已受双重身份验证保护，敏感操作确认在通过后 5 分钟内有效。</Callout.Text></Callout.Root>
              <Box className="mfa-status-grid">
                <Text size="2" color="gray">启用时间</Text><Text size="2">{mfaStatus.enabled_at ? new Date(mfaStatus.enabled_at).toLocaleString() : '-'}</Text>
                <Text size="2" color="gray">剩余恢复码</Text><Text size="2">{mfaStatus.recovery_codes_remaining} 个</Text>
              </Box>
              <Flex gap="2" wrap="wrap">
                <Button variant="soft" onClick={() => setShowRebind((value) => !value)} disabled={mfaLoading}><QrCode size={16} />重新绑定验证器</Button>
                <Button variant="soft" onClick={() => void regenerateRecoveryCodes()} disabled={mfaLoading}><RefreshCw size={16} />重新生成恢复码</Button>
                <Button color="red" variant="soft" onClick={() => setDisableDialogOpen(true)} disabled={mfaLoading}><ShieldOff size={16} />关闭双重验证</Button>
              </Flex>
              {showRebind && (
                <Box className="mfa-rebind-panel">
                  <Text size="2" weight="bold">重新绑定验证器</Text>
                  <Text size="2" color="gray">输入当前密码后生成新密钥；完成绑定前，现有验证器继续有效。</Text>
                  <Flex gap="2" mt="2" wrap="wrap">
                    <TextField.Root className="mfa-password-input" type="password" value={setupPassword} autoComplete="current-password" placeholder="当前密码" onChange={e => setSetupPassword(e.target.value)} />
                    <Button onClick={() => void startMfaSetup()} disabled={mfaLoading || !setupPassword}><KeyRound size={16} />开始重新绑定</Button>
                  </Flex>
                </Box>
              )}
            </Flex>
          ) : setup ? (
            <Flex direction="column" gap="4">
              <Callout.Root color="amber"><Callout.Icon><QrCode size={18} /></Callout.Icon><Callout.Text>扫描二维码后输入当前动态验证码。验证成功前不会替换现有配置。</Callout.Text></Callout.Root>
              <Flex className="mfa-setup-layout" gap="4" align="start">
                <Box className="mfa-qr-box">{qrDataUrl ? <img src={qrDataUrl} alt="TOTP 二维码" /> : <Text color="gray">正在生成二维码...</Text>}</Box>
                <Flex direction="column" gap="3" className="mfa-setup-fields">
                  <Box><Text size="2" weight="bold">无法扫码时手动输入</Text><code className="mfa-secret-code">{setup.secret}</code></Box>
                  <label><Text size="2" weight="bold">6 位动态验证码</Text><TextField.Root className="admin-account-input" value={setupCode} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" onChange={e => setSetupCode(e.target.value)} /></label>
                  <Flex gap="2" wrap="wrap">
                    <Button onClick={() => void enableMfa()} disabled={mfaLoading}><ShieldCheck size={16} />{mfaLoading ? '验证中...' : '确认启用'}</Button>
                    <Button variant="soft" color="gray" onClick={() => { setSetup(null); setSetupCode(''); }} disabled={mfaLoading}>取消</Button>
                  </Flex>
                </Flex>
              </Flex>
            </Flex>
          ) : (
            <Flex direction="column" gap="4">
              <Callout.Root><Callout.Icon><ShieldCheck size={18} /></Callout.Icon><Callout.Text>启用后，登录后台及执行敏感操作时需要动态验证码或恢复码。</Callout.Text></Callout.Root>
              <label><Text size="2" weight="bold">当前密码</Text><TextField.Root className="admin-account-input" type="password" value={setupPassword} autoComplete="current-password" placeholder="验证当前密码后开始绑定" onChange={e => setSetupPassword(e.target.value)} /></label>
              <Button onClick={() => void startMfaSetup()} disabled={mfaLoading || !setupPassword}><QrCode size={16} />{mfaLoading ? '处理中...' : '开始设置'}</Button>
            </Flex>
          )}
        </Card>
      )}

      <Dialog.Root open={disableDialogOpen} onOpenChange={(open) => { if (!mfaLoading) setDisableDialogOpen(open); }}>
        <Dialog.Content style={{ maxWidth: 440 }}>
          <Dialog.Title>
            <Flex align="center" gap="2"><ShieldOff size={20} />确认关闭双重身份验证</Flex>
          </Dialog.Title>
          <Dialog.Description size="2" color="gray">
            关闭后，登录和敏感操作将不再需要动态验证码，现有恢复码也会立即失效。
          </Dialog.Description>
          <Flex justify="end" gap="2" mt="4">
            <Button variant="soft" color="gray" disabled={mfaLoading} onClick={() => setDisableDialogOpen(false)}>取消</Button>
            <Button color="red" disabled={mfaLoading} onClick={() => void disableMfa()}>
              <ShieldOff size={16} />{mfaLoading ? '关闭中...' : '确认关闭'}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={recoveryCodes.length > 0} onOpenChange={(open) => { if (!open) setRecoveryCodes([]); }}>
        <Dialog.Content className="mfa-recovery-dialog" style={{ maxWidth: 520 }}>
          <Dialog.Title>保存恢复码</Dialog.Title>
          <Dialog.Description color="red" mb="3">恢复码只显示这一次。每个恢复码只能使用一次，请离线安全保存。</Dialog.Description>
          <div className="mfa-recovery-code-grid">
            {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
          </div>
          <Flex justify="end" gap="2" mt="4" wrap="wrap">
            <Button variant="soft" onClick={() => void copyRecoveryCodes()}><Copy size={16} />复制</Button>
            <Button variant="soft" onClick={() => downloadRecoveryCodes(recoveryCodes, user?.username || 'admin')}><Download size={16} />下载文本</Button>
            <Button onClick={() => setRecoveryCodes([])}>我已保存</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}