export function ensureActiveThemeStylesheet() {
  const existing = document.getElementById('cf-monitor-active-theme-css') as HTMLLinkElement | null;
  if (existing) return existing;
  const link = document.createElement('link');
  link.id = 'cf-monitor-active-theme-css';
  link.rel = 'stylesheet';
  link.href = '/api/theme/active.css';
  document.head.appendChild(link);
  return link;
}

/**
 * 一次数据变更会唤醒多个订阅者，若每次都改写 href 就会重复下载同一份样式表。
 * 短窗口内合并为一次重载——主题变更对这点延迟不敏感。
 * 后台"应用主题"等需要立即生效的场景可传 force 跳过合并。
 */
const THEME_REFRESH_MIN_INTERVAL_MS = 3_000;
let lastThemeRefreshAt = 0;

export function refreshActiveThemeStylesheet(options: { force?: boolean } = {}) {
  const link = document.getElementById('cf-monitor-active-theme-css') as HTMLLinkElement | null;
  if (!link) return null;
  const now = Date.now();
  if (!options.force && now - lastThemeRefreshAt < THEME_REFRESH_MIN_INTERVAL_MS) return link;
  lastThemeRefreshAt = now;
  link.href = `/api/theme/active.css?v=${now}`;
  return link;
}

export function removeActiveThemeStylesheet(): void {
  document.getElementById('cf-monitor-active-theme-css')?.remove();
  lastThemeRefreshAt = 0;
}
