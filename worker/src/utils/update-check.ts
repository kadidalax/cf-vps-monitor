export type UpdateCheckResult = {
  current_version: string;
  latest_version: string;
  current_commit: string;
  latest_commit: string;
  has_update: boolean;
  source_url: string;
  upgrade_url: string | null;
  repository_url: string | null;
  title: string;
  body: string;
  published_at: string;
};

export function formatAppVersion(version: string | undefined): string {
  const value = (version || '').trim() || 'dev';
  return value.startsWith('v') || value === 'dev' ? value : `v${value}`;
}

export function canonicalGitHubRepositoryUrl(repositoryUrl: string | undefined): string | null {
  if (!repositoryUrl) return null;
  const raw = repositoryUrl.trim();
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

export function repositoryUrlFromRepositoryUrl(repositoryUrl: string | undefined): string | null {
  return canonicalGitHubRepositoryUrl(repositoryUrl);
}

export function normalizeGitSha(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function shortGitSha(value: string | undefined): string {
  return normalizeGitSha(value).slice(0, 7);
}
