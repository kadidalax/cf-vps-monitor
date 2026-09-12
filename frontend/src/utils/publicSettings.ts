import { fetchWithBootstrapRetry } from './api.ts';

const PUBLIC_SETTINGS_CACHE_MS = 30_000;

export interface PublicThemeSettings {
  backgroundImageUrlDesktop: string;
  backgroundImageUrlMobile: string;
  mainContentWidth: number;
}

export interface PublicSettings {
  site_title: string;
  site_subtitle: string;
  site_description: string;
  language: string;
  script_domain: string;
  site_logo_url: string;
  ping_record_persist_interval_sec: string;
  live_poll_active_interval_sec: string;
  live_poll_idle_interval_sec: string;
  live_poll_active_max_duration_sec: string;
  active_theme: string;
  theme_settings: PublicThemeSettings;
}

const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  site_title: 'CF VPS Monitor',
  site_subtitle: '',
  site_description: '服务器监控探针',
  language: 'zh-CN',
  script_domain: '',
  site_logo_url: '',
  ping_record_persist_interval_sec: '120',
  live_poll_active_interval_sec: '3',
  live_poll_idle_interval_sec: '120',
  live_poll_active_max_duration_sec: '120',
  active_theme: 'monitor',
  theme_settings: {
    backgroundImageUrlDesktop: '',
    backgroundImageUrlMobile: '',
    mainContentWidth: 100,
  },
};

let cachedPublicSettings: { value: PublicSettings; expiresAt: number } | null = null;
let inflightPublicSettings: Promise<PublicSettings> | null = null;
/** 在途请求是否以 force 发起；force 调用只能复用同样 force 的在途请求。 */
let inflightPublicSettingsIsForced = false;
let publicSettingsGeneration = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringSetting(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value : fallback;
  return text.length <= maxLength ? text : fallback;
}

function integerSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function secondsSetting(value: unknown, fallback: string, min: number, max: number): string {
  return String(integerSetting(value, Number(fallback), min, max));
}

function activeThemeSetting(value: unknown, fallback: string): string {
  const text = stringSetting(value, fallback, 64);
  const activeTheme = text === 'default' ? 'monitor' : text;
  return /^[A-Za-z0-9_-]+$/.test(activeTheme) ? activeTheme : fallback;
}

export function normalizePublicSettings(payload: unknown): PublicSettings | null {
  const record = asRecord(payload);
  if (!record) return null;
  const theme = asRecord(record.theme_settings);

  return {
    site_title: stringSetting(record.site_title, DEFAULT_PUBLIC_SETTINGS.site_title, 128),
    site_subtitle: stringSetting(record.site_subtitle, DEFAULT_PUBLIC_SETTINGS.site_subtitle, 128),
    site_description: stringSetting(record.site_description, DEFAULT_PUBLIC_SETTINGS.site_description, 512),
    language: stringSetting(record.language, DEFAULT_PUBLIC_SETTINGS.language, 32),
    script_domain: stringSetting(record.script_domain, DEFAULT_PUBLIC_SETTINGS.script_domain, 256),
    site_logo_url: stringSetting(record.site_logo_url, DEFAULT_PUBLIC_SETTINGS.site_logo_url, 256),
    ping_record_persist_interval_sec: secondsSetting(record.ping_record_persist_interval_sec, '120', 60, 3600),
    live_poll_active_interval_sec: secondsSetting(record.live_poll_active_interval_sec, '3', 3, 300),
    live_poll_idle_interval_sec: secondsSetting(record.live_poll_idle_interval_sec, '120', 60, 3600),
    live_poll_active_max_duration_sec: secondsSetting(record.live_poll_active_max_duration_sec, '120', 60, 3600),
    active_theme: activeThemeSetting(record.active_theme, DEFAULT_PUBLIC_SETTINGS.active_theme),
    theme_settings: {
      backgroundImageUrlDesktop: stringSetting(
        theme?.backgroundImageUrlDesktop,
        DEFAULT_PUBLIC_SETTINGS.theme_settings.backgroundImageUrlDesktop,
        1024,
      ),
      backgroundImageUrlMobile: stringSetting(
        theme?.backgroundImageUrlMobile,
        DEFAULT_PUBLIC_SETTINGS.theme_settings.backgroundImageUrlMobile,
        1024,
      ),
      mainContentWidth: integerSetting(theme?.mainContentWidth, 100, 60, 100),
    },
  };
}

export function setCachedPublicSettings(settings: PublicSettings): void {
  publicSettingsGeneration += 1;
  cachedPublicSettings = {
    value: settings,
    expiresAt: Date.now() + PUBLIC_SETTINGS_CACHE_MS,
  };
}

export function clearCachedPublicSettings(): void {
  publicSettingsGeneration += 1;
  cachedPublicSettings = null;
  inflightPublicSettings = null;
  inflightPublicSettingsIsForced = false;
}

export async function fetchPublicSettings(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<PublicSettings> {
  if (!options.force && cachedPublicSettings && cachedPublicSettings.expiresAt > Date.now()) {
    return cachedPublicSettings.value;
  }
  // 并发去重：一次通知会同时唤醒多个订阅者。要求最新数据的调用方只能复用
  // 同样以 force 发起的在途请求，否则可能拿到走了缓存的旧响应。
  if (inflightPublicSettings && (!options.force || inflightPublicSettingsIsForced)) {
    return inflightPublicSettings;
  }

  const publicSettingsUrl = options.force ? `/api/public?v=${Date.now()}` : '/api/public';
  const generation = ++publicSettingsGeneration;
  const promise = fetchWithBootstrapRetry(publicSettingsUrl, { signal: options.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const settings = normalizePublicSettings(await res.json());
      if (settings) {
        if (generation === publicSettingsGeneration) setCachedPublicSettings(settings);
        return settings;
      }
      throw new Error('Invalid public settings response');
    })
    .finally(() => {
      if (inflightPublicSettings === promise) {
        inflightPublicSettings = null;
        inflightPublicSettingsIsForced = false;
      }
    });

  inflightPublicSettings = promise;
  inflightPublicSettingsIsForced = Boolean(options.force);
  return promise;
}
