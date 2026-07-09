import { validateWebhookUrl } from '../utils/webhook.ts';

type SettingType = 'string' | 'boolean' | 'integer' | 'enum';

interface SettingDefinition {
  type: SettingType;
  defaultValue: string;
  public: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  values?: readonly string[];
  minLengthWhenSet?: number;
}

export const REMOVED_SETTING_KEYS = new Set([
  'allow_cors',
  'private_site',
  'private_site_password',
  'tempory_share_token',
  'tempory_share_token_expire_at',
  'temporary_share_token',
  'temporary_share_token_expire_at',
  'custom_head',
  'custom_body',
  'custom_footer_html',
  'agent_auto_discovery_key',
  'update_mode',
]);

export const SETTING_SCHEMA = {
  site_title: {
    type: 'string',
    defaultValue: 'CF VPS Monitor',
    public: true,
    maxLength: 128,
  },
  site_subtitle: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 128,
  },
  site_description: {
    type: 'string',
    defaultValue: '服务器监控探针',
    public: true,
    maxLength: 512,
  },
  language: {
    type: 'string',
    defaultValue: 'zh-CN',
    public: true,
    maxLength: 32,
  },
  script_domain: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 256,
  },
  site_logo_url: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 256,
  },
  site_logo_data: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 1500000,
  },
  site_logo_type: {
    type: 'string',
    defaultValue: '',
    public: false,
    maxLength: 64,
  },
  update_repository_url: {
    type: 'string',
    defaultValue: '',
    public: false,
    maxLength: 256,
  },
  record_enabled: {
    type: 'boolean',
    defaultValue: 'true',
    public: false,
  },
  record_preserve_time: {
    type: 'integer',
    defaultValue: '72',
    public: false,
    min: 1,
    max: 72,
  },
  ping_record_preserve_time: {
    type: 'integer',
    defaultValue: '72',
    public: false,
    min: 1,
    max: 72,
  },
  record_persist_interval_sec: {
    type: 'integer',
    defaultValue: '120',
    public: false,
    min: 3,
    max: 3600,
  },
  ping_record_persist_interval_sec: {
    type: 'integer',
    defaultValue: '120',
    public: true,
    min: 60,
    max: 3600,
  },
  record_high_watermark_rows: {
    type: 'integer',
    defaultValue: '450000',
    public: false,
    min: 1000,
    max: 10000000,
  },
  capacity_daily_view_minutes: {
    type: 'integer',
    defaultValue: '60',
    public: false,
    min: 0,
    max: 1440,
  },
  audit_log_preserve_time: {
    type: 'integer',
    defaultValue: '2160',
    public: false,
    min: 24,
    max: 87600,
  },
  live_poll_active_interval_sec: {
    type: 'integer',
    defaultValue: '3',
    public: true,
    min: 3,
    max: 300,
  },
  live_poll_idle_interval_sec: {
    type: 'integer',
    defaultValue: '120',
    public: true,
    min: 60,
    max: 3600,
  },
  live_poll_active_max_duration_sec: {
    type: 'integer',
    defaultValue: '120',
    public: true,
    min: 60,
    max: 3600,
  },
  notification_method: {
    type: 'enum',
    defaultValue: 'telegram',
    public: false,
    values: ['telegram', 'email', 'webhook', 'none'],
  },
  telegram_bot_token: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 256,
  },
  telegram_chat_id: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 128,
  },
  email_smtp_host: {
    type: 'string',
    defaultValue: '',
    public: false,
    maxLength: 255,
  },
  email_smtp_port: {
    type: 'integer',
    defaultValue: '587',
    public: false,
    min: 1,
    max: 65535,
  },
  email_smtp_security: {
    type: 'enum',
    defaultValue: 'starttls',
    public: false,
    values: ['starttls', 'tls'],
  },
  email_smtp_username: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 255,
  },
  email_smtp_password: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 512,
  },
  email_smtp_from_address: {
    type: 'string',
    defaultValue: '',
    public: false,
    maxLength: 254,
  },
  email_smtp_from_name: {
    type: 'string',
    defaultValue: 'CF VPS Monitor',
    public: false,
    maxLength: 128,
  },
  email_smtp_recipients: {
    type: 'string',
    defaultValue: '',
    public: false,
    maxLength: 4000,
  },
  email_smtp_auth_method: {
    type: 'enum',
    defaultValue: 'plain',
    public: false,
    values: ['plain', 'login'],
  },
  webhook_url: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 2048,
  },
  webhook_format: {
    type: 'enum',
    defaultValue: 'generic',
    public: false,
    values: ['generic', 'slack', 'discord', 'feishu', 'dingtalk', 'wecom', 'custom'],
  },
  webhook_secret: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 512,
  },
  webhook_method: {
    type: 'enum',
    defaultValue: 'POST',
    public: false,
    values: ['GET', 'POST'],
  },
  webhook_content_type: {
    type: 'string',
    defaultValue: 'application/json',
    public: false,
    maxLength: 128,
  },
  webhook_headers_json: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 4000,
  },
  webhook_body_template: {
    type: 'string',
    defaultValue: '{"message":"{{message}}","title":"{{title}}"}',
    public: false,
    maxLength: 8000,
  },
  webhook_username: {
    type: 'string',
    defaultValue: '',
    public: false,
    maxLength: 256,
  },
  webhook_password: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 512,
  },
  webhook_retry_count: {
    type: 'integer',
    defaultValue: '1',
    public: false,
    min: 1,
    max: 3,
  },
  enable_ip_change_notification: {
    type: 'boolean',
    defaultValue: 'false',
    public: false,
  },
  offline_notify_never_reported: {
    type: 'boolean',
    defaultValue: 'true',
    public: false,
  },
  theme_bg_desktop: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 1024,
  },
  theme_bg_mobile: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 1024,
  },
  theme_content_width: {
    type: 'integer',
    defaultValue: '100',
    public: true,
    min: 60,
    max: 100,
  },
  active_theme: {
    type: 'string',
    defaultValue: 'monitor',
    public: true,
    maxLength: 64,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTING_SCHEMA;

export const SETTING_KEYS = Object.keys(SETTING_SCHEMA) as SettingKey[];
export const PUBLIC_SETTING_KEYS = SETTING_KEYS.filter(key => SETTING_SCHEMA[key].public);
const SETTING_KEY_SET = new Set<string>(SETTING_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function settingToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function normalizeBoolean(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return 'true';
  if (normalized === 'false' || normalized === '0') return 'false';
  return null;
}

function normalizeInteger(value: unknown, definition: SettingDefinition): string | null {
  if (value === '' || value === null || value === undefined) {
    return definition.defaultValue;
  }
  const numberValue = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numberValue) || !Number.isInteger(numberValue)) return null;
  if (definition.min !== undefined && numberValue < definition.min) return null;
  if (definition.max !== undefined && numberValue > definition.max) return null;
  return String(numberValue);
}

function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function normalizeScriptDomain(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHttpHost(url.hostname))) return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeSiteLogoUrl(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  return /^\/api\/site-logo(?:\?v=\d+)?$/.test(raw) ? raw : null;
}

function normalizeUpdateRepositoryUrl(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : raw.startsWith('github.com/')
      ? `https://${raw}`
      : /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(raw)
        ? `https://github.com/${raw}`
        : raw;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `https://github.com/${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function normalizeSmtpHost(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!host || host === 'localhost') return null;
  if (/[\s/@:]/.test(host)) return null;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return null;
  return host;
}

function normalizeEmailAddress(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (!email || email.length > 254) return null;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

function normalizeEmailRecipients(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4000) return null;
  const recipients = value
    .split(/[;,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  if (recipients.length === 0 || recipients.length > 20) return null;
  if (recipients.some(item => !normalizeEmailAddress(item))) return null;
  return [...new Set(recipients)].join(',');
}

function normalizeWebhookUrl(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const normalized = validateWebhookUrl(value);
  return normalized.ok ? normalized.url : null;
}

function normalizeWebhookContentType(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return SETTING_SCHEMA.webhook_content_type.defaultValue;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\r\n]/.test(text) || /[\x00-\x1f\x7f]/.test(text)) return null;
  return text.includes('/') ? text : null;
}

function normalizeWebhookHeadersJson(value: unknown): string | null {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Object.entries(parsed).some(([key, item]) => !key || typeof item !== 'string')) return null;
    return text;
  } catch {
    return null;
  }
}

export function isKnownSettingKey(key: string): key is SettingKey {
  return SETTING_KEY_SET.has(key);
}

export function normalizeSettingValue(
  key: string,
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!isKnownSettingKey(key)) {
    return { ok: false, error: `未知设置: ${key}` };
  }

  const definition: SettingDefinition = SETTING_SCHEMA[key];
  let normalized: string | null = null;

  switch (definition.type) {
    case 'boolean':
      normalized = normalizeBoolean(value);
      break;
    case 'integer':
      normalized = normalizeInteger(value, definition);
      break;
    case 'enum': {
      const text = settingToString(value);
      normalized = text && definition.values?.includes(text) ? text : null;
      break;
    }
    case 'string':
      if (key === 'script_domain') normalized = normalizeScriptDomain(value);
      else if (key === 'site_logo_url') normalized = normalizeSiteLogoUrl(value);
      else if (key === 'update_repository_url') normalized = normalizeUpdateRepositoryUrl(value);
      else if (key === 'email_smtp_host') normalized = normalizeSmtpHost(value);
      else if (key === 'email_smtp_from_address') normalized = normalizeEmailAddress(value);
      else if (key === 'email_smtp_recipients') normalized = normalizeEmailRecipients(value);
      else if (key === 'webhook_url') normalized = normalizeWebhookUrl(value);
      else if (key === 'webhook_content_type') normalized = normalizeWebhookContentType(value);
      else if (key === 'webhook_headers_json') normalized = normalizeWebhookHeadersJson(value);
      else if (key === 'active_theme') {
        const text = settingToString(value)?.trim() || SETTING_SCHEMA.active_theme.defaultValue;
        const activeTheme = text === 'default' ? 'monitor' : text;
        normalized = /^[A-Za-z0-9_-]+$/.test(activeTheme) ? activeTheme : null;
      } else normalized = settingToString(value);
      break;
  }

  if (normalized === null) {
    return { ok: false, error: `${key} 类型或取值无效` };
  }

  if (key === 'email_smtp_port' && normalized === '25') {
    return { ok: false, error: 'email_smtp_port 不支持 25 端口' };
  }

  if (definition.maxLength !== undefined && normalized.length > definition.maxLength) {
    return { ok: false, error: `${key} 超过最大长度 ${definition.maxLength}` };
  }

  if (
    definition.minLengthWhenSet !== undefined &&
    normalized.length > 0 &&
    normalized.length < definition.minLengthWhenSet
  ) {
    return { ok: false, error: `${key} 至少需要 ${definition.minLengthWhenSet} 个字符` };
  }

  return { ok: true, value: normalized };
}

export function sanitizeSettingsForStorage(
  input: unknown,
  options: { ignoreRemoved?: boolean } = {},
): { ok: boolean; settings: Record<string, string>; errors: string[]; ignoredKeys: string[] } {
  const ignoreRemoved = options.ignoreRemoved ?? true;
  if (!isPlainObject(input)) {
    return { ok: false, settings: {}, errors: ['设置必须是对象'], ignoredKeys: [] };
  }

  const settings: Record<string, string> = {};
  const errors: string[] = [];
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (REMOVED_SETTING_KEYS.has(key) && ignoreRemoved) {
      ignoredKeys.push(key);
      continue;
    }
    const normalized = normalizeSettingValue(key, value);
    if (!normalized.ok) {
      errors.push(normalized.error);
      continue;
    }
    settings[key] = normalized.value;
  }

  return { ok: errors.length === 0, settings, errors, ignoredKeys };
}

export function buildAdminSettings(stored: Record<string, string>): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const normalized = normalizeSettingValue(key, stored[key] ?? SETTING_SCHEMA[key].defaultValue);
    settings[key] = normalized.ok ? normalized.value : SETTING_SCHEMA[key].defaultValue;
  }
  return settings;
}

export type PublicThemeSettings = {
  backgroundImageUrlDesktop: string;
  backgroundImageUrlMobile: string;
  mainContentWidth: number;
};

export type PublicSettings = Record<string, string | PublicThemeSettings> & {
  theme_settings: PublicThemeSettings;
};

export function buildPublicSettings(stored: Record<string, string>): PublicSettings {
  const adminSettings = buildAdminSettings(stored);
  const publicSettings: Record<string, string | PublicThemeSettings> = {};

  for (const key of SETTING_KEYS) {
    if (!SETTING_SCHEMA[key].public || key.startsWith('theme_')) continue;
    publicSettings[key] = adminSettings[key];
  }

  publicSettings.theme_settings = {
    backgroundImageUrlDesktop: adminSettings.theme_bg_desktop,
    backgroundImageUrlMobile: adminSettings.theme_bg_mobile,
    mainContentWidth: Number(adminSettings.theme_content_width),
  };

  return publicSettings as PublicSettings;
}

export function isRecordPersistenceEnabled(settings: Record<string, string> | string | null | undefined): boolean {
  const value = typeof settings === 'string'
    ? settings
    : settings?.record_enabled;
  const normalized = normalizeSettingValue('record_enabled', value ?? SETTING_SCHEMA.record_enabled.defaultValue);
  return normalized.ok ? normalized.value === 'true' : true;
}
