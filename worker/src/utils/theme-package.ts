import { strFromU8, unzipSync } from 'fflate';

export type ThemeConfigItemType = 'title' | 'switch' | 'select' | 'number' | 'string' | 'richtext' | 'color' | 'image' | 'range';

export interface ThemeConfigItem {
  key?: string;
  name?: string;
  type: ThemeConfigItemType;
  options?: string;
  default?: unknown;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface ThemeManifest {
  name: string;
  short: string;
  description?: string;
  version?: string;
  author?: string;
  url?: string;
  preview?: string;
  style: string;
  configuration?: {
    type?: string;
    data?: ThemeConfigItem[];
  };
}

export interface ThemeRecordInput {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  preview_path: string;
  style_path: string;
  manifest_json: string;
  config_json: string;
  custom_css: string;
}

export interface ThemeAssetInput {
  path: string;
  content_type: string;
  content_base64: string;
  size_bytes: number;
}

export interface ParsedThemePackage {
  theme: ThemeRecordInput;
  assets: ThemeAssetInput[];
}

const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_CSS_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_ASSETS = 32;
const MAX_CUSTOM_CSS_BYTES = 64 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.json', '.woff2']);
const FORBIDDEN_EXTENSIONS = new Set(['.js', '.html', '.htm', '.wasm', '.woff', '.ttf', '.otf', '.eot']);
const CONFIG_TYPES = new Set<ThemeConfigItemType>(['title', 'switch', 'select', 'number', 'string', 'richtext', 'color', 'image', 'range']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeThemePath(path: unknown): string {
  if (typeof path !== 'string') throw new Error('theme path must be a string');
  const normalized = path.trim().replace(/^\.\/+/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`invalid theme path: ${path}`);
  }
  return normalized;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function contentTypeFor(path: string): string {
  const ext = extensionOf(path);
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

function assertAllowedFile(path: string): void {
  const ext = extensionOf(path);
  if (FORBIDDEN_EXTENSIONS.has(ext) || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`theme file extension is not allowed: ${path}`);
  }
}

function normalizeString(value: unknown, field: string, maxLength: number, required = false): string {
  if (value == null || value === '') {
    if (required) throw new Error(`theme manifest ${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`theme manifest ${field} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`theme manifest ${field} is required`);
  if (text.length > maxLength) throw new Error(`theme manifest ${field} is too long`);
  return text;
}

function normalizeOptionalNumber(value: unknown, field: string): number | undefined {
  if (value == null || value === '') return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`theme config ${field} must be a number`);
  return numberValue;
}

function normalizeConfigItems(value: unknown): ThemeConfigItem[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('theme manifest configuration.data must be an array');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`theme config item ${index + 1} is invalid`);
    const type = item.type;
    if (typeof type !== 'string' || !CONFIG_TYPES.has(type as ThemeConfigItemType)) {
      throw new Error(`theme config item ${index + 1} type is invalid`);
    }
    const key = type === 'title' ? undefined : normalizeString(item.key, 'configuration.data.key', 96, true);
    const min = normalizeOptionalNumber(item.min, 'min');
    const max = normalizeOptionalNumber(item.max, 'max');
    const step = normalizeOptionalNumber(item.step, 'step');
    if (type === 'range') {
      if (min !== undefined && max !== undefined && min > max) throw new Error(`theme config item ${index + 1} range min must be <= max`);
      if (step !== undefined && step <= 0) throw new Error(`theme config item ${index + 1} range step must be positive`);
    }
    return {
      type: type as ThemeConfigItemType,
      ...(key ? { key } : {}),
      name: normalizeString(item.name, 'configuration.data.name', 128),
      help: normalizeString(item.help, 'configuration.data.help', 256),
      options: normalizeString(item.options, 'configuration.data.options', 512),
      min,
      max,
      step,
      default: item.default,
    };
  });
}

function isSafeImageConfigValue(value: string): boolean {
  if (!value) return true;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function normalizeThemeManifest(input: unknown): ThemeManifest {
  if (!isRecord(input)) throw new Error('theme manifest must be an object');
  const short = normalizeString(input.short, 'short', 64, true);
  if (short === 'default' || !/^[A-Za-z0-9_-]+$/.test(short)) {
    throw new Error('theme manifest short is invalid');
  }
  const style = normalizeThemePath(normalizeString(input.style, 'style', 256, true));
  if (extensionOf(style) !== '.css') throw new Error('theme style must be a CSS file');
  const preview = input.preview ? normalizeThemePath(normalizeString(input.preview, 'preview', 256)) : '';
  if (preview && !['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extensionOf(preview))) {
    throw new Error('theme preview must be an image');
  }
  const configuration = isRecord(input.configuration) ? input.configuration : {};
  const type = typeof configuration.type === 'string' ? configuration.type : 'managed';
  if (type !== 'managed') throw new Error('theme configuration.type must be managed');
  return {
    name: normalizeString(input.name, 'name', 128, true),
    short,
    description: normalizeString(input.description, 'description', 512),
    version: normalizeString(input.version, 'version', 64),
    author: normalizeString(input.author, 'author', 128),
    url: normalizeString(input.url, 'url', 512),
    preview,
    style,
    configuration: {
      type: 'managed',
      data: normalizeConfigItems(configuration.data),
    },
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    result += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63] + alphabet[(chunk >> 6) & 63] + alphabet[chunk & 63];
  }
  if (index < bytes.length) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const chunk = (a << 16) | (b << 8);
    result += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63];
    result += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : '=';
    result += '=';
  }
  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function parseThemeZip(zipBytes: Uint8Array): ParsedThemePackage {
  if (zipBytes.byteLength > MAX_ZIP_BYTES) throw new Error('theme zip is too large');
  const files = unzipSync(zipBytes);
  const entries = Object.entries(files)
    .filter(([path]) => !path.endsWith('/'))
    .map(([rawPath, bytes]) => [normalizeThemePath(rawPath), bytes] as const);
  if (entries.length > MAX_ASSETS + 1) throw new Error('theme package has too many files');
  const fileMap = new Map(entries);

  const manifestBytes = fileMap.get('cf-monitor-theme.json');
  if (!manifestBytes) throw new Error('theme manifest cf-monitor-theme.json is required');
  const manifest = normalizeThemeManifest(JSON.parse(strFromU8(manifestBytes)));

  for (const [path] of entries) assertAllowedFile(path);
  const styleBytes = fileMap.get(manifest.style);
  if (!styleBytes) throw new Error('theme style file is missing');
  if (styleBytes.byteLength > MAX_CSS_BYTES) throw new Error('theme CSS is too large');
  if (manifest.preview && !fileMap.has(manifest.preview)) throw new Error('theme preview file is missing');
  const defaultConfig = defaultConfigForManifest(manifest);
  const defaultValidation = validateThemeConfig(manifest, defaultConfig);
  if (!defaultValidation.ok) throw new Error(defaultValidation.error);

  const assets: ThemeAssetInput[] = [];
  for (const [path, bytes] of entries) {
    if (path === 'cf-monitor-theme.json') continue;
    const ext = extensionOf(path);
    if (ext !== '.css' && bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`theme asset is too large: ${path}`);
    assets.push({
      path,
      content_type: contentTypeFor(path),
      content_base64: bytesToBase64(bytes),
      size_bytes: bytes.byteLength,
    });
  }

  return {
    theme: {
      short: manifest.short,
      name: manifest.name,
      description: manifest.description || '',
      version: manifest.version || '',
      author: manifest.author || '',
      url: manifest.url || '',
      preview_path: manifest.preview || '',
      style_path: manifest.style,
      manifest_json: JSON.stringify(manifest),
      config_json: JSON.stringify(defaultValidation.config),
      custom_css: '',
    },
    assets,
  };
}

function defaultConfigForManifest(manifest: ThemeManifest): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const item of manifest.configuration?.data || []) {
    if (item.key && item.default !== undefined) config[item.key] = item.default;
  }
  return config;
}

export function validateThemeConfig(
  manifestInput: ThemeManifest | unknown,
  configInput: unknown,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const manifest = normalizeThemeManifest(manifestInput);
  const input = isRecord(configInput) ? configInput : {};
  const items = (manifest.configuration?.data || []).filter(item => item.key);
  const itemByKey = new Map(items.map(item => [item.key!, item]));
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!itemByKey.has(key)) return { ok: false, error: `未知主题配置: ${key}` };
  }
  for (const item of items) {
    const value = input[item.key!];
    if (value === undefined) {
      if (item.default !== undefined) config[item.key!] = item.default;
      continue;
    }
    if (item.type === 'switch') config[item.key!] = Boolean(value);
    else if (item.type === 'number' || item.type === 'range') {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) return { ok: false, error: `${item.key} 必须是数字` };
      if ((item.min !== undefined && numberValue < item.min) || (item.max !== undefined && numberValue > item.max)) {
        return { ok: false, error: `${item.key} 不在可选范围内` };
      }
      config[item.key!] = numberValue;
    } else if (item.type === 'color') {
      const text = String(value).trim();
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)) {
        return { ok: false, error: `${item.key} 必须是十六进制颜色` };
      }
      config[item.key!] = text;
    } else if (item.type === 'select') {
      const text = String(value);
      const options = (item.options || '').split(',').map(option => option.trim()).filter(Boolean);
      if (options.length > 0 && !options.includes(text)) return { ok: false, error: `${item.key} 不在可选范围内` };
      config[item.key!] = text;
    } else if (item.type === 'image') {
      const text = String(value).trim();
      if (!isSafeImageConfigValue(text)) return { ok: false, error: `${item.key} 必须是 HTTPS 图片 URL 或同源路径` };
      config[item.key!] = text;
    } else {
      config[item.key!] = String(value);
    }
  }
  return { ok: true, config };
}

function cssVarValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value).replace(/[;{}]/g, '').trim();
}

export function buildThemeCss({
  styleCss,
  config,
  customCss,
}: {
  styleCss: string;
  config: Record<string, unknown>;
  customCss: string;
}): string {
  const variables = Object.entries(config)
    .filter(([key]) => /^[A-Za-z0-9_-]+$/.test(key))
    .map(([key, value]) => `  --cf-theme-${key}: ${cssVarValue(value)};`);
  return [
    variables.length > 0 ? `:root {\n${variables.join('\n')}\n}` : '',
    styleCss,
    customCss.slice(0, MAX_CUSTOM_CSS_BYTES),
  ].filter(Boolean).join('\n\n');
}
