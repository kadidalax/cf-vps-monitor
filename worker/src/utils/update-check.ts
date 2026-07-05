export type UpdateCheckResult = {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  release_url: string;
  actions_url: string | null;
  workflow_configured: boolean;
  title: string;
  body: string;
  published_at: string;
};

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function parseSemver(version: string): [number, number, number] | null {
  const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (parsedA && parsedB) {
    for (let i = 0; i < 3; i += 1) {
      if (parsedA[i] > parsedB[i]) return 1;
      if (parsedA[i] < parsedB[i]) return -1;
    }
    return 0;
  }

  const normalizedA = normalizeVersion(a);
  const normalizedB = normalizeVersion(b);
  if (normalizedA === normalizedB) return 0;
  if (normalizedA === 'dev') return -1;
  if (normalizedB === 'dev') return 1;
  return normalizedA > normalizedB ? 1 : -1;
}

export function workflowUrlFromRepositoryUrl(repositoryUrl: string | undefined): string | null {
  if (!repositoryUrl) return null;
  try {
    const url = new URL(repositoryUrl.trim());
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `https://github.com/${parts[0]}/${parts[1]}/actions/workflows/update-from-upstream.yml`;
  } catch {
    return null;
  }
}

export function branchPackageJsonUrl(repository: string, branch: string): string {
  return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/worker/package.json`;
}

export function normalizeGitSha(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function shortGitSha(value: string | undefined): string {
  return normalizeGitSha(value).slice(0, 7);
}
