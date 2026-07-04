export function formatAppVersion(version?: string | null, fallback = 'dev') {
  const value = version?.trim();
  if (!value) return fallback;
  return /^v/i.test(value) || !/^\d/.test(value) ? value : `v${value}`;
}
