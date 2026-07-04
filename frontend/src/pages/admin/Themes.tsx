import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  Flex,
  Grid,
  Select,
  Switch,
  Text,
  TextArea,
  TextField,
} from '@radix-ui/themes';
import { Check, Eye, Palette, Plus, RotateCcw, Settings, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { useDisplayTheme } from '../../contexts/DisplayThemeContext';
import { clearCachedPublicSettings } from '../../utils/publicSettings';
import { normalizeDisplayTheme } from '../../utils/displayTheme';
import { notifyThemeUpdated } from '../../utils/themeEvents';

type ThemeConfigItem = {
  key?: string;
  name?: string;
  type: 'title' | 'switch' | 'select' | 'number' | 'string' | 'richtext' | 'color' | 'image' | 'range';
  options?: string;
  default?: unknown;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
};

type ThemeManifest = {
  name: string;
  short: string;
  configuration?: {
    data?: ThemeConfigItem[];
  };
};

type ThemeCard = {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  preview_url: string;
  active: boolean;
  deletable: boolean;
  configurable: boolean;
  manifest: ThemeManifest | null;
  config: Record<string, unknown>;
  custom_css: string;
};

type ThemesResponse = {
  active_theme: string;
  data: ThemeCard[];
};

function refreshActiveThemeStylesheet() {
  const link = document.getElementById('cf-monitor-active-theme-css') as HTMLLinkElement | null;
  if (link) link.href = `/api/theme/active.css?v=${Date.now()}`;
}

function configLabel(item: ThemeConfigItem) {
  return item.name || item.key || '';
}

const PREVIEW_STYLE_ID = 'cf-monitor-theme-css-preview';

const cssExampleSnippets = [
  {
    name: '背景/字体',
    css: `/* 全局背景和字体 */
.layout {
  background: #f8fafc;
  color: #111827;
}`,
  },
  {
    name: '导航栏',
    css: `/* 顶部导航栏 */
.nav-bar {
  background: rgba(255, 255, 255, 0.86);
  border-color: rgba(15, 23, 42, 0.12);
}`,
  },
  {
    name: '节点卡片',
    css: `/* 节点卡片 */
.node-card {
  border-radius: 16px;
  box-shadow: 0 14px 38px rgba(15, 23, 42, 0.1);
}`,
  },
  {
    name: '统计卡片',
    css: `/* 统计卡片 */
.monitor-stat-card {
  background: #ffffff;
}`,
  },
  {
    name: '进度条',
    css: `/* 进度条和状态色 */
.usage-bar-fill {
  background: linear-gradient(90deg, #22c55e, #0ea5e9);
}`,
  },
  {
    name: '移动端',
    css: `/* 移动端 */
@media (max-width: 640px) {
  .node-card {
    border-radius: 12px;
  }
}`,
  },
];

const themeCssExamples = cssExampleSnippets.map(item => item.css).join('\n\n');

function setPreviewCss(css: string) {
  let style = document.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = PREVIEW_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function clearPreviewCss() {
  document.getElementById(PREVIEW_STYLE_ID)?.remove();
}

export default function AdminThemes() {
  const apiFetch = useApi();
  const { setDisplayTheme } = useDisplayTheme();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [themes, setThemes] = useState<ThemeCard[]>([]);
  const [editing, setEditing] = useState<ThemeCard | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({});
  const [customCss, setCustomCss] = useState('');
  const [deleting, setDeleting] = useState<ThemeCard | null>(null);

  async function loadThemes() {
    setLoading(true);
    try {
      const result = await apiFetch('/admin/themes') as ThemesResponse;
      setThemes(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '主题列表加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadThemes();
  }, []);

  useEffect(() => {
    return clearPreviewCss;
  }, []);

  async function handleUpload(file: File | null) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setSaving(true);
    try {
      await apiFetch('/admin/themes/upload', { method: 'POST', body: form });
      toast.success('主题已上传');
      await loadThemes();
      refreshActiveThemeStylesheet();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleSetTheme(theme: ThemeCard) {
    setSaving(true);
    try {
      await apiFetch('/admin/themes/set', {
        method: 'POST',
        body: JSON.stringify({ short: theme.short }),
      });
      const nextActiveTheme = theme.short;
      setThemes(items => items.map(item => ({ ...item, active: item.short === nextActiveTheme })));
      setDisplayTheme(normalizeDisplayTheme(nextActiveTheme));
      refreshActiveThemeStylesheet();
      clearCachedPublicSettings();
      notifyThemeUpdated();
      toast.success('主题已启用');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启用失败');
    } finally {
      setSaving(false);
    }
  }

  function openConfig(theme: ThemeCard) {
    clearPreviewCss();
    setEditing(theme);
    setEditConfig(theme.config || {});
    setCustomCss(theme.custom_css || '');
  }

  function closeConfig() {
    clearPreviewCss();
    setEditing(null);
  }

  function insertCssSnippet(css: string) {
    setCustomCss(current => [current.trimEnd(), css].filter(Boolean).join('\n\n'));
  }

  function previewCustomCss() {
    setPreviewCss(customCss);
    toast.success('已临时预览，仅当前浏览器生效');
  }

  function restoreCustomCss() {
    setCustomCss(editing?.custom_css || '');
    clearPreviewCss();
    toast.success('已恢复为保存前内容');
  }

  async function saveConfig() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch('/admin/themes/settings', {
        method: 'POST',
        body: JSON.stringify({ short: editing.short, config: editConfig, custom_css: customCss }),
      });
      toast.success('主题配置已保存');
      closeConfig();
      await loadThemes();
      refreshActiveThemeStylesheet();
      clearCachedPublicSettings();
      notifyThemeUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setSaving(true);
    try {
      await apiFetch('/admin/themes/delete', {
        method: 'POST',
        body: JSON.stringify({ short: deleting.short }),
      });
      setDeleting(null);
      await loadThemes();
      refreshActiveThemeStylesheet();
      clearCachedPublicSettings();
      notifyThemeUpdated();
      toast.success('主题已删除');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setSaving(false);
    }
  }

  function updateConfig(key: string, value: unknown) {
    setEditConfig(current => ({ ...current, [key]: value }));
  }

  function renderConfigField(item: ThemeConfigItem) {
    if (item.type === 'title') {
      return <Text key={item.name || 'title'} size="3" weight="bold">{item.name}</Text>;
    }
    if (!item.key) return null;
    const value = editConfig[item.key] ?? item.default ?? '';
    if (item.type === 'switch') {
      return (
        <Flex key={item.key} align="center" justify="between" gap="3">
          <Box>
            <Text as="div" size="2" weight="medium">{configLabel(item)}</Text>
            {item.help ? <Text as="div" size="1" color="gray">{item.help}</Text> : null}
          </Box>
          <Switch checked={Boolean(value)} onCheckedChange={checked => updateConfig(item.key!, checked)} />
        </Flex>
      );
    }
    if (item.type === 'select') {
      const options = (item.options || '').split(',').map(option => option.trim()).filter(Boolean);
      return (
        <label key={item.key} className="admin-theme-config-field">
          <Text size="2" weight="medium">{configLabel(item)}</Text>
          <Select.Root value={String(value)} onValueChange={next => updateConfig(item.key!, next)}>
            <Select.Trigger />
            <Select.Content>
              {options.map(option => <Select.Item key={option} value={option}>{option}</Select.Item>)}
            </Select.Content>
          </Select.Root>
        </label>
      );
    }
    if (item.type === 'richtext') {
      return (
        <label key={item.key} className="admin-theme-config-field">
          <Text size="2" weight="medium">{configLabel(item)}</Text>
          <TextArea value={String(value)} onChange={event => updateConfig(item.key!, event.target.value)} />
        </label>
      );
    }
    if (item.type === 'color') {
      return (
        <label key={item.key} className="admin-theme-config-field">
          <Text size="2" weight="medium">{configLabel(item)}</Text>
          <input
            className="admin-theme-color-input"
            type="color"
            value={String(value || '#000000')}
            onChange={event => updateConfig(item.key!, event.target.value)}
          />
        </label>
      );
    }
    if (item.type === 'range') {
      const min = item.min ?? 0;
      const max = item.max ?? 100;
      const step = item.step ?? 1;
      const numberValue = Number(value || min);
      return (
        <label key={item.key} className="admin-theme-config-field">
          <Flex justify="between" gap="2">
            <Text size="2" weight="medium">{configLabel(item)}</Text>
            <Text size="2" color="gray">{numberValue}</Text>
          </Flex>
          <input
            className="admin-theme-range-input"
            type="range"
            min={min}
            max={max}
            step={step}
            value={numberValue}
            onChange={event => updateConfig(item.key!, Number(event.target.value))}
          />
        </label>
      );
    }
    return (
      <label key={item.key} className="admin-theme-config-field">
        <Text size="2" weight="medium">{configLabel(item)}</Text>
        <TextField.Root
          type={item.type === 'number' ? 'number' : 'text'}
          placeholder={item.type === 'image' ? 'https://example.com/bg.webp 或 /api/theme/assets/主题ID/bg.webp' : undefined}
          value={String(value)}
          onChange={event => updateConfig(item.key!, item.type === 'number' ? Number(event.target.value) : event.target.value)}
        />
      </label>
    );
  }

  function renderThemePreview(theme: ThemeCard) {
    return theme.preview_url ? <img src={theme.preview_url} alt="" /> : <Palette size={34} />;
  }

  if (loading) return <Loading />;

  return (
    <Flex className="admin-themes-page" direction="column" gap="3">
      <Flex className="admin-parent-title-row admin-server-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Palette size={20} />
          <Text size="5" weight="bold">主题管理</Text>
        </Flex>
      </Flex>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={event => void handleUpload(event.target.files?.[0] || null)}
      />
      <Flex className="admin-theme-page-actions" justify="between" gap="3" wrap="wrap">
        <Text as="p" size="1" color="gray" className="admin-theme-package-guidance">
          主题包根目录需要 cf-monitor-theme.json；支持 CSS、图片、JSON 和 .woff2 字体；配置项支持 title、switch、select、number、string、richtext、color、image、range。
        </Text>
        <Button className="admin-theme-upload-action" size="2" disabled={saving} onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} />上传主题包
        </Button>
      </Flex>

      <Grid className="admin-theme-grid" gap="4">
        {themes.map(theme => (
          <Card key={theme.short} className="admin-theme-card">
            <Flex direction="column" gap="2" height="100%">
              <div className="admin-theme-preview">
                {renderThemePreview(theme)}
              </div>
              <Flex align="start" justify="between" gap="3">
                <Box>
                  <Text as="div" size="4" weight="bold">{theme.name}</Text>
                  <Text as="div" size="2" color="gray">{theme.author || 'Unknown'}{theme.version ? ` · ${theme.version}` : ''}</Text>
                </Box>
                {theme.active ? <Badge color="green"><Check size={12} />当前</Badge> : null}
              </Flex>
              <Text as="p" size="2" color="gray" className="admin-theme-description">
                {theme.description || '暂无描述'}
              </Text>
              <Flex className="admin-theme-actions" gap="1" wrap="wrap">
                <Button size="2" variant={theme.active ? 'soft' : 'solid'} disabled={saving || theme.active} onClick={() => void handleSetTheme(theme)}>
                  <Check size={14} />启用
                </Button>
                <Button size="2" variant="soft" disabled={!theme.configurable} onClick={() => openConfig(theme)}>
                  <Settings size={14} />配置
                </Button>
                <Button size="2" color="red" variant="soft" disabled={!theme.deletable} onClick={() => setDeleting(theme)}>
                  <Trash2 size={14} />删除
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Grid>

      <Dialog.Root open={!!editing} onOpenChange={open => !open && closeConfig()}>
        <Dialog.Content aria-describedby={undefined} maxWidth="720px">
          <Dialog.Title>配置主题</Dialog.Title>
          <Flex direction="column" gap="4">
            {(editing?.manifest?.configuration?.data || []).map(renderConfigField)}
            <label className="admin-theme-config-field">
              <Text size="2" weight="medium">自定义 CSS</Text>
              <Text as="p" size="1" color="gray">
                可以调整前台页面的颜色、背景、字体、间距、圆角、阴影、导航栏、节点卡片、统计卡片、按钮、徽章和响应式样式；不能修改后台页面、数据来源、接口逻辑、通知规则或新增交互功能。
              </Text>
              <TextArea className="admin-theme-custom-css" value={customCss} onChange={event => setCustomCss(event.target.value)} />
            </label>
            <Box className="admin-theme-css-guide">
              <Text as="div" size="2" weight="medium">可改区域示例</Text>
              <Text as="p" size="1" color="gray">复制需要的片段到上方自定义 CSS 后修改数值即可。</Text>
              <Flex className="admin-theme-snippet-actions" gap="2" wrap="wrap">
                {cssExampleSnippets.map(item => (
                  <Button key={item.name} size="1" variant="soft" onClick={() => insertCssSnippet(item.css)}>
                    <Plus size={12} />插入{item.name}
                  </Button>
                ))}
              </Flex>
              <pre>{themeCssExamples}</pre>
            </Box>
            <Flex justify="end" gap="2">
              <Button variant="soft" onClick={previewCustomCss}>
                <Eye size={14} />预览
              </Button>
              <Button variant="soft" onClick={restoreCustomCss}>
                <RotateCcw size={14} />恢复
              </Button>
              <Dialog.Close><Button variant="soft">取消</Button></Dialog.Close>
              <Button disabled={saving} onClick={() => void saveConfig()}>保存</Button>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <Dialog.Content aria-describedby={undefined} maxWidth="460px">
          <Dialog.Title>删除主题</Dialog.Title>
          <Flex direction="column" gap="3">
            <Text size="2">删除后主题资源会被移除。若正在启用，会切回 Monitor 主题。</Text>
            <Flex justify="end" gap="2">
              <Dialog.Close><Button variant="soft">取消</Button></Dialog.Close>
              <Button color="red" disabled={saving} onClick={() => void confirmDelete()}>删除</Button>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
