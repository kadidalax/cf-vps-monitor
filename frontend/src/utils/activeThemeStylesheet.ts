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

export function refreshActiveThemeStylesheet() {
  ensureActiveThemeStylesheet().href = `/api/theme/active.css?v=${Date.now()}`;
}
