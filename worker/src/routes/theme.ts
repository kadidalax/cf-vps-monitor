import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import {
  base64ToBytes,
  buildThemeCss,
  normalizeThemeManifest,
  normalizeThemePath,
  parseThemeZip,
  validateThemeConfig,
} from '../utils/theme-package';
import { readJsonWithLimit, readRequestBytesWithLimit } from '../utils/request-body';
import { invalidatePublicMetadataCache } from './public';

type ThemeContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export const adminThemeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
export const publicThemeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_THEME_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_THEME_JSON_BYTES = 256 * 1024;
const MAX_THEME_CUSTOM_CSS_BYTES = 64 * 1024;
const BUILTIN_STYLE_PATH = 'builtin.css';
const BUILTIN_THEMES = [
  {
    short: 'monitor',
    name: 'Monitor',
    description: '项目内置Monitor主题',
    previewUrl: '/theme-previews/monitor.svg',
  },
  {
    short: 'next',
    name: 'Next',
    description: '项目内置 Next 主题',
    previewUrl: '/theme-previews/next.svg',
  },
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isUploadedFile(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return !!value && typeof value === 'object' && 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

async function readJsonObject(c: ThemeContext): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const parsed = await readJsonWithLimit(c.req.raw, MAX_THEME_JSON_BYTES);
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') return { response: c.json({ error: `请求内容不能超过 ${MAX_THEME_JSON_BYTES} 字节` }, 413) };
    return { response: c.json({ error: '请求 JSON 格式错误' }, 400) };
  }
  return isObject(parsed.body) ? { body: parsed.body } : { response: c.json({ error: '请求内容必须是 JSON 对象' }, 400) };
}

function jsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeManifest(value: string): ReturnType<typeof normalizeThemeManifest> | null {
  try {
    return normalizeThemeManifest(JSON.parse(value));
  } catch {
    return null;
  }
}

function isBuiltinTheme(short: string): short is typeof BUILTIN_THEMES[number]['short'] {
  return BUILTIN_THEMES.some(theme => theme.short === short);
}

function builtinThemePreviewUrl(short: string): string {
  return BUILTIN_THEMES.find(theme => theme.short === short)?.previewUrl || '';
}

function normalizeActiveTheme(short: string | null | undefined): string {
  return short && short !== 'default' ? short : 'monitor';
}

function builtinThemeRecord(short: typeof BUILTIN_THEMES[number]['short']): db.ThemeUpsertInput {
  const builtin = BUILTIN_THEMES.find(theme => theme.short === short)!;
  const manifest = {
    name: builtin.name,
    short: builtin.short,
    description: builtin.description,
    version: '',
    author: 'CF VPS Monitor',
    url: '',
    preview: '',
    style: BUILTIN_STYLE_PATH,
    configuration: {
      type: 'managed',
      data: [],
    },
  };
  return {
    short: builtin.short,
    name: builtin.name,
    description: builtin.description,
    version: '',
    author: 'CF VPS Monitor',
    url: '',
    preview_path: '',
    style_path: BUILTIN_STYLE_PATH,
    manifest_json: JSON.stringify(manifest),
    config_json: '{}',
    custom_css: '',
  };
}

async function ensureBuiltinTheme(database: ReturnType<typeof getDatabase>, short: typeof BUILTIN_THEMES[number]['short']): Promise<db.Theme> {
  const existing = await db.getTheme(database, short);
  if (existing) return existing;
  const builtin = { theme: builtinThemeRecord(short) };
  await db.upsertTheme(database, builtin.theme, []);
  return { ...builtin.theme, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

function themeSummary(theme: db.Theme, activeTheme: string) {
  const manifest = safeManifest(theme.manifest_json);
  const builtin = isBuiltinTheme(theme.short);
  return {
    short: theme.short,
    name: theme.name,
    description: theme.description,
    version: theme.version,
    author: theme.author,
    url: theme.url,
    preview_path: theme.preview_path,
    preview_url: builtin ? builtinThemePreviewUrl(theme.short) : theme.preview_path ? `/api/theme/assets/${encodeURIComponent(theme.short)}/${theme.preview_path}` : '',
    active: activeTheme === theme.short,
    deletable: !builtin,
    configurable: true,
    manifest,
    config: jsonParseObject(theme.config_json),
    custom_css: theme.custom_css,
  };
}

function builtinThemeSummary(short: typeof BUILTIN_THEMES[number]['short'], activeTheme: string, stored?: db.Theme) {
  return themeSummary(stored || { ...builtinThemeRecord(short), created_at: '', updated_at: '' }, activeTheme);
}

function cssResponse(css: string): Response {
  return new Response(css, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    },
  });
}

function publicJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    },
  });
}

function themeAssetHeaders(contentType: string): HeadersInit {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; font-src 'self'",
  };
}

adminThemeRoutes.get('/', async (c) => {
  const database = getDatabase(c.env);
  const [activeTheme, themes] = await Promise.all([
    db.getSetting(database, 'active_theme').then(normalizeActiveTheme),
    db.listThemes(database),
  ]);
  const themeMap = new Map(themes.map(theme => [theme.short, theme]));
  const builtinSummaries = BUILTIN_THEMES.map(theme => builtinThemeSummary(theme.short, activeTheme, themeMap.get(theme.short)));
  const uploadedSummaries = themes
    .filter(theme => !isBuiltinTheme(theme.short))
    .map(theme => themeSummary(theme, activeTheme));
  return c.json({
    active_theme: activeTheme,
    data: [...builtinSummaries, ...uploadedSummaries],
  });
});

adminThemeRoutes.post('/upload', async (c) => {
  const body = await readRequestBytesWithLimit(c.req.raw, MAX_THEME_ZIP_BYTES + 4096);
  if (!body.ok) {
    return c.json({ error: `主题包不能超过 ${MAX_THEME_ZIP_BYTES} 字节` }, 413);
  }

  let form: FormData;
  try {
    form = await new Response(body.bytes, {
      headers: { 'Content-Type': c.req.header('Content-Type') || '' },
    }).formData();
  } catch {
    return c.json({ error: '主题包表单格式错误' }, 400);
  }
  const file = form.get('file');
  if (!isUploadedFile(file)) return c.json({ error: '请上传主题 zip 文件' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_THEME_ZIP_BYTES) {
    return c.json({ error: `主题包不能超过 ${MAX_THEME_ZIP_BYTES} 字节` }, 413);
  }
  let parsed: ReturnType<typeof parseThemeZip>;
  try {
    parsed = parseThemeZip(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    return c.json({ error: `主题包解析失败: ${detail}` }, 400);
  }
  if (isBuiltinTheme(parsed.theme.short)) return c.json({ error: '不能覆盖内置主题' }, 400);

  const database = getDatabase(c.env);
  const existing = await db.getTheme(database, parsed.theme.short);
  if (existing) {
    const manifest = normalizeThemeManifest(JSON.parse(parsed.theme.manifest_json));
    const validated = validateThemeConfig(manifest, jsonParseObject(existing.config_json));
    parsed.theme.config_json = JSON.stringify(validated.ok ? validated.config : jsonParseObject(parsed.theme.config_json));
    parsed.theme.custom_css = existing.custom_css;
  }

  await db.upsertTheme(database, parsed.theme, parsed.assets);
  invalidatePublicMetadataCache();
  await db.insertAuditLog(database, c.get('username')!, 'theme_upload', `上传主题: ${parsed.theme.short}`);
  return c.json({ success: true, theme: themeSummary({ ...parsed.theme, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, await db.getSetting(database, 'active_theme') || 'default') });
});

adminThemeRoutes.post('/set', async (c) => {
  const parsed = await readJsonObject(c);
  if ('response' in parsed) return parsed.response;
  const short = normalizeActiveTheme(typeof parsed.body.short === 'string' ? parsed.body.short.trim() : '');
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: '主题 ID 无效' }, 400);
  const database = getDatabase(c.env);
  if (!isBuiltinTheme(short) && !await db.getTheme(database, short)) {
    return c.json({ error: '主题不存在' }, 404);
  }
  await db.setSetting(database, 'active_theme', short);
  invalidatePublicMetadataCache();
  await db.insertAuditLog(database, c.get('username')!, 'theme_set', `启用主题: ${short}`);
  return c.json({ success: true, active_theme: short });
});

adminThemeRoutes.post('/settings', async (c) => {
  const parsed = await readJsonObject(c);
  if ('response' in parsed) return parsed.response;
  const short = normalizeActiveTheme(typeof parsed.body.short === 'string' ? parsed.body.short.trim() : '');
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: '主题 ID 无效' }, 400);
  const customCss = typeof parsed.body.custom_css === 'string' ? parsed.body.custom_css : '';
  if (new TextEncoder().encode(customCss).byteLength > MAX_THEME_CUSTOM_CSS_BYTES) {
    return c.json({ error: `自定义 CSS 不能超过 ${MAX_THEME_CUSTOM_CSS_BYTES} 字节` }, 413);
  }
  const database = getDatabase(c.env);
  const theme = isBuiltinTheme(short) ? await ensureBuiltinTheme(database, short) : await db.getTheme(database, short);
  if (!theme) return c.json({ error: '主题不存在' }, 404);
  const manifest = normalizeThemeManifest(JSON.parse(theme.manifest_json));
  const config = validateThemeConfig(manifest, parsed.body.config);
  if (!config.ok) return c.json({ error: config.error }, 400);
  await db.updateThemeSettings(database, short, JSON.stringify(config.config), customCss);
  invalidatePublicMetadataCache();
  await db.insertAuditLog(database, c.get('username')!, 'theme_settings', `配置主题: ${short}`);
  return c.json({ success: true });
});

adminThemeRoutes.post('/delete', async (c) => {
  const parsed = await readJsonObject(c);
  if ('response' in parsed) return parsed.response;
  const short = normalizeActiveTheme(typeof parsed.body.short === 'string' ? parsed.body.short.trim() : '');
  if (!/^[A-Za-z0-9_-]+$/.test(short) || isBuiltinTheme(short)) return c.json({ error: '内置主题不能删除' }, 400);
  const database = getDatabase(c.env);
  const activeTheme = normalizeActiveTheme(await db.getSetting(database, 'active_theme'));
  const deleted = await db.deleteTheme(database, short);
  if (!deleted) return c.json({ error: '主题不存在' }, 404);
  if (activeTheme === short) await db.setSetting(database, 'active_theme', 'monitor');
  invalidatePublicMetadataCache();
  await db.insertAuditLog(database, c.get('username')!, 'theme_delete', `删除主题: ${short}`);
  return c.json({ success: true, active_theme: activeTheme === short ? 'monitor' : activeTheme });
});

publicThemeRoutes.get('/active.css', async (c) => {
  try {
    const database = getDatabase(c.env);
    const activeTheme = normalizeActiveTheme(await db.getSetting(database, 'active_theme'));
    const theme = await db.getTheme(database, activeTheme);
    if (!theme) return cssResponse('');
    const asset = isBuiltinTheme(theme.short) ? null : await db.getThemeAsset(database, theme.short, theme.style_path);
    if (!asset && !isBuiltinTheme(theme.short)) return cssResponse('');
    return cssResponse(buildThemeCss({
      styleCss: asset ? new TextDecoder().decode(base64ToBytes(asset.content_base64)) : '',
      config: jsonParseObject(theme.config_json),
      customCss: theme.custom_css,
    }));
  } catch {
    return cssResponse('');
  }
});

publicThemeRoutes.get('/assets/:theme/*', async (c) => {
  const theme = c.req.param('theme');
  if (!/^[A-Za-z0-9_-]+$/.test(theme)) return c.json({ error: 'Not Found' }, 404);
  let path: string;
  try {
    path = normalizeThemePath(c.req.param('*'));
  } catch {
    return c.json({ error: 'Not Found' }, 404);
  }
  const asset = await db.getThemeAsset(getDatabase(c.env), theme, path);
  if (!asset) return c.json({ error: 'Not Found' }, 404);
  return new Response(base64ToBytes(asset.content_base64), {
    headers: themeAssetHeaders(asset.content_type),
  });
});

publicThemeRoutes.get('/manifest/:theme', async (c) => {
  const short = normalizeActiveTheme(c.req.param('theme'));
  if (isBuiltinTheme(short)) return publicJson(builtinThemeSummary(short, short, await db.getTheme(getDatabase(c.env), short) || undefined));
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return c.json({ error: 'Not Found' }, 404);
  const theme = await db.getTheme(getDatabase(c.env), short);
  if (!theme) return c.json({ error: 'Not Found' }, 404);
  return publicJson({
    short: theme.short,
    manifest: safeManifest(theme.manifest_json),
    config: jsonParseObject(theme.config_json),
  });
});
