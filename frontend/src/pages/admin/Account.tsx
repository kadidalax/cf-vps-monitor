import { useEffect, useState } from 'react';
import { Flex, Card, Text, Heading, Button, TextField, Tabs } from '@radix-ui/themes';
import { Save, User } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useAuth } from '../../contexts/AuthContext';

type AccountTab = 'username' | 'password';

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

  useEffect(() => {
    setUsername(user?.username || '');
  }, [user?.username]);

  const handleChangeUsername = async () => {
    const nextUsername = username.trim();
    if (!nextUsername) {
      toast.error('用户名不能为空');
      return;
    }
    if (nextUsername === user?.username) {
      toast.info('用户名没有变化');
      return;
    }

    setSavingUsername(true);
    try {
      const result = await apiFetch('/admin/account/username', {
        method: 'POST',
        body: JSON.stringify({ username: nextUsername }),
      });

      if (result.success) {
        const nextUser = result.user || { username: nextUsername };
        updateUser(nextUser);
        setUsername(nextUser.username || nextUsername);
        toast.success('用户名修改成功');
      } else {
        toast.error(result.error || '修改失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '修改失败');
    } finally {
      setSavingUsername(false);
    }
  };

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) {
      toast.error('请填写所有字段');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('密码长度至少 6 位');
      return;
    }

    setSaving(true);
    const result = await apiFetch('/admin/account/chpasswd', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
    setSaving(false);

    if (result.success) {
      toast.success('密码修改成功');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      toast.error(result.error || '修改失败');
    }
  };

  return (
    <div className="admin-account-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <User size={20} />
          <Heading size="5">账户设置</Heading>
        </Flex>
      </Flex>

      <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3" mb="3">
        <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as AccountTab)}>
          <Tabs.List className="admin-subnav-row">
            <Tabs.Trigger value="username">更改用户名</Tabs.Trigger>
            <Tabs.Trigger value="password">更改密码</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </Flex>

      {activeTab === 'username' ? (
        <Card className="admin-account-card">
          <Heading size="3" mb="3">更改用户名</Heading>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">用户名</Text>
              <TextField.Root
                style={{ width: '100%', marginTop: '4px' }}
                value={username}
                autoComplete="username"
                spellCheck={false}
                onChange={e => setUsername(e.target.value)}
              />
            </label>
            <Button
              variant="soft"
              onClick={handleChangeUsername}
              disabled={savingUsername || username.trim() === (user?.username || '')}
            >
              <Save size={16} /> {savingUsername ? '保存中...' : '修改用户名'}
            </Button>
          </Flex>
        </Card>
      ) : (
        <Card className="admin-account-card">
          <Heading size="3" mb="3">更改密码</Heading>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">旧密码</Text>
              <TextField.Root
                style={{ width: '100%', marginTop: '4px' }}
                type="password"
                value={oldPassword}
                autoComplete="current-password"
                onChange={e => setOldPassword(e.target.value)}
              />
            </label>
            <label>
              <Text size="2" weight="bold">新密码</Text>
              <TextField.Root
                style={{ width: '100%', marginTop: '4px' }}
                type="password"
                value={newPassword}
                autoComplete="new-password"
                onChange={e => setNewPassword(e.target.value)}
              />
            </label>
            <label>
              <Text size="2" weight="bold">确认新密码</Text>
              <TextField.Root
                style={{ width: '100%', marginTop: '4px' }}
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                onChange={e => setConfirmPassword(e.target.value)}
              />
            </label>
            <Button onClick={handleChangePassword} disabled={saving}>
              <Save size={16} /> {saving ? '保存中...' : '修改密码'}
            </Button>
          </Flex>
        </Card>
      )}
    </div>
  );
}
