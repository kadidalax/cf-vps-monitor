import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { Download, RotateCcw, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { SettingCard, SettingInput } from '../../components/admin/SettingCard';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';
import { requestPassword } from '../../utils/reauth';
import { notifyPublicDataUpdated } from '../../utils/publicDataEvents';
import { buildApiRequest } from '../../utils/api';
import type { SettingsLayoutOutletContext } from './SettingsLayout';

const MIN_BACKUP_PASSWORD_LENGTH = 6;
const MAX_LOGO_BYTES = 1024 * 1024;

function backupEncryptPasswordError(password: string): string | null {
  if (Array.from(password).length < MIN_BACKUP_PASSWORD_LENGTH) return `备份密码至少需要 ${MIN_BACKUP_PASSWORD_LENGTH} 位`;
  return null;
}

export default function SettingsSite() {
  const apiFetch = useApi();
  const { setAction, settingsCache, loadSettingsScope, setSettingsScope } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>(() => settingsCache.site || {});
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>(() => settingsCache.site || {});
  const [loading, setLoading] = useState(!settingsCache.site);
  const [saving, setSaving] = useState(false);
  const [logoSaving, setLogoSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    loadSettingsScope('site')
      .then((nextSettings) => {
        setSettings(nextSettings);
        setOriginalSettings(nextSettings);
      })
      .finally(() => setLoading(false));
  }, [loadSettingsScope]);

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = useCallback(async () => {
    const changedSettings = getChangedSettings(settings, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        setOriginalSettings((prev) => ({ ...prev, ...changedSettings }));
        setSettingsScope('site', { ...settings, ...changedSettings });
        notifyPublicDataUpdated();
        toast.success('设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, originalSettings, setSettingsScope, settings]);

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={loading || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, loading, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  const downloadBackupFile = async (filename: string, backupPassword: string) => {
    const { url: requestUrl, init } = buildApiRequest('/admin/download/backup', {
      method: 'POST',
      body: JSON.stringify({ backup_password: backupPassword }),
    });
    const response = await fetch(requestUrl, init);
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || '下载失败');
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(blobUrl);
  };

  const handleDownloadBackup = async () => {
    const password = await requestPassword(
      '请设置备份文件密码，不是管理员登录密码。至少 6 位。',
      {
        autocomplete: 'new-password',
        validate: backupEncryptPasswordError,
      },
    );
    if (!password) return;

    try {
      await downloadBackupFile(`cf-monitor-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`, password);
      toast.success('加密完整备份已下载，请保存好备份密码');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份下载失败');
    }
  };

  const handleUploadBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const data = JSON.parse(await file.text());
      const password = await requestPassword('请输入该备份文件的加密密码', {
        autocomplete: 'off',
      });
      if (!password) return;
      const beforeRestorePassword = await requestPassword(
        '恢复前会自动下载当前配置的加密备份。请设置临时备份文件密码，至少 6 位。',
        {
          autocomplete: 'new-password',
          validate: backupEncryptPasswordError,
        },
      );
      if (!beforeRestorePassword) return;
      await downloadBackupFile(`cf-monitor-before-restore-${new Date().toISOString().slice(0, 10)}.json`, beforeRestorePassword);
      const result = await apiFetch('/admin/upload/backup?confirm_restore=true&acknowledge_overwrite=true', {
        method: 'POST',
        body: JSON.stringify({
          backup: data,
          backup_password: password,
          confirm_restore: true,
          acknowledge_overwrite: true,
        }),
      });

      if (!result.success) {
        toast.error(result.error || '恢复失败');
        return;
      }

      toast.success('备份已恢复');
      const nextSettings = await apiFetch('/admin/settings?scope=site');
      if (nextSettings && typeof nextSettings === 'object') {
        setSettings(nextSettings as SettingsMap);
        setOriginalSettings(nextSettings as SettingsMap);
        setSettingsScope('site', nextSettings as SettingsMap);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份文件格式错误');
    } finally {
      event.target.value = '';
    }
  };

  const handleUploadLogo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Logo 只支持 PNG、JPG、WebP');
      event.target.value = '';
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Logo 不能超过 1MB');
      event.target.value = '';
      return;
    }

    const form = new FormData();
    form.append('file', file);
    setLogoSaving(true);
    try {
      const result = await apiFetch('/admin/site-logo', { method: 'POST', body: form });
      const siteLogoUrl = typeof result.site_logo_url === 'string' ? result.site_logo_url : '';
      setSettings((prev) => ({ ...prev, site_logo_url: siteLogoUrl }));
      setOriginalSettings((prev) => ({ ...prev, site_logo_url: siteLogoUrl }));
      setSettingsScope('site', { ...settings, site_logo_url: siteLogoUrl });
      notifyPublicDataUpdated();
      toast.success('Logo 已上传');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Logo 上传失败');
    } finally {
      setLogoSaving(false);
      event.target.value = '';
    }
  };

  const handleResetLogo = async () => {
    setLogoSaving(true);
    try {
      await apiFetch('/admin/site-logo/reset', { method: 'POST' });
      setSettings((prev) => ({ ...prev, site_logo_url: '' }));
      setOriginalSettings((prev) => ({ ...prev, site_logo_url: '' }));
      setSettingsScope('site', { ...settings, site_logo_url: '' });
      notifyPublicDataUpdated();
      toast.success('已恢复默认 Logo');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复默认 Logo 失败');
    } finally {
      setLogoSaving(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <Flex direction="column" gap="4">
      <SettingCard title="基本信息" description="站点名称、描述、语言与安装脚本域名" defaultOpen>
        <Box style={{ marginBottom: 16 }}>
          <Text size="2" weight="medium" style={{ display: 'block', marginBottom: 4 }}>站点 Logo</Text>
          <Text size="1" color="gray" style={{ display: 'block', marginBottom: 8 }}>
            显示在前台导航栏和后台登录页，支持 PNG、JPG、WebP，最大 1MB。
          </Text>
          <Flex align="center" gap="3" wrap="wrap">
            <Box className="site-logo-preview">
              <img src={settings.site_logo_url || '/app-icon.png'} alt="" />
            </Box>
            <Flex gap="2" wrap="wrap">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={handleUploadLogo}
              />
              <Button variant="soft" disabled={logoSaving} onClick={() => logoInputRef.current?.click()}>
                <Upload size={16} /> {logoSaving ? '处理中...' : '上传 Logo'}
              </Button>
              <Button variant="soft" color="gray" disabled={logoSaving || !settings.site_logo_url} onClick={handleResetLogo}>
                <RotateCcw size={16} /> 恢复默认
              </Button>
            </Flex>
          </Flex>
        </Box>
        <SettingInput
          label="站点标题"
          description="显示在导航栏和浏览器标签页"
          value={settings.site_title || ''}
          onChange={(value) => updateSetting('site_title', value)}
          placeholder="CF VPS Monitor"
        />
        <SettingInput
          label="站点副标题"
          description="显示在首页标题区"
          value={settings.site_subtitle || ''}
          onChange={(value) => updateSetting('site_subtitle', value)}
          placeholder="Cloudflare server monitor"
        />
        <SettingInput
          label="站点描述"
          description="用于页脚与元信息"
          value={settings.site_description || ''}
          onChange={(value) => updateSetting('site_description', value)}
          placeholder="服务器监控探针"
        />
        <SettingInput
          label="语言"
          description="界面语言设置"
          value={settings.language || 'zh-CN'}
          onChange={(value) => updateSetting('language', value)}
          placeholder="zh-CN"
        />
        <SettingInput
          label="脚本域名"
          description="生成安装命令时使用的站点地址；留空则使用当前域名"
          value={settings.script_domain || ''}
          onChange={(value) => updateSetting('script_domain', value)}
          placeholder={window.location.origin}
        />
      </SettingCard>

      <SettingCard title="备份与恢复" description="导出或导入系统配置" defaultOpen>
        <Flex direction="column" gap="3">
          <Box style={{ border: '1px solid var(--amber-6)', background: 'var(--amber-2)', borderRadius: 8, padding: 12 }}>
            <Text size="2" weight="bold" color="amber">备份包含完整敏感配置，但文件会加密</Text>
            <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>
              备份会包含节点 token、AutoDiscovery Key、Telegram 凭据和通知配置，但导出的 JSON 只保存 AES-GCM 密文。恢复时必须输入导出时设置的备份密码。
            </Text>
          </Box>
          <Text size="1" color="gray">
            导出内容包含服务器列表、系统设置、Ping 任务、离线通知和负载通知；不包含管理员账户、审计日志和历史监控数据。恢复会覆盖对应配置，并清理不存在服务器的历史记录。
          </Text>
          <Flex gap="3" wrap="wrap" mt="2">
            <Button variant="soft" onClick={handleDownloadBackup}>
              <Download size={16} /> 导出加密完整备份
            </Button>
            <div>
              <input
                type="file"
                id="backup-upload-site"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleUploadBackup}
              />
              <Button variant="soft" onClick={() => document.getElementById('backup-upload-site')?.click()}>
                <Upload size={16} /> 导入备份
              </Button>
            </div>
          </Flex>
        </Flex>
      </SettingCard>
    </Flex>
  );
}
