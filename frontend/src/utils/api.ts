/**
 * API helper layer.
 * Uses same-origin HttpOnly session cookies for admin requests.
 */

export const API_BASE = '/api';
export const CSRF_COOKIE_NAME = 'cf_monitor_csrf';
const BOOTSTRAP_RETRY_ATTEMPTS = 6;
const BOOTSTRAP_RETRY_DELAY_MS = 1000;

export function withApiBase(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedPath === API_BASE || normalizedPath.startsWith(`${API_BASE}/`)) {
    return normalizedPath;
  }
  return `${API_BASE}${normalizedPath}`;
}

export function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

export function isUnsafeMethod(method: string | undefined): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes((method || 'GET').toUpperCase());
}

export function buildApiRequest(path: string, options: RequestInit = {}): { url: string; init: RequestInit } {
  const headers = new Headers(options.headers);
  const isFormData = options.body instanceof FormData;
  if (!headers.has('Content-Type') && !isFormData) {
    headers.set('Content-Type', 'application/json');
  }
  const url = withApiBase(path);
  if (url.startsWith(`${API_BASE}/admin/`) && isUnsafeMethod(options.method) && !headers.has('X-CSRF-Token')) {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  return {
    url,
    init: {
      ...options,
      headers,
      credentials: 'same-origin',
    },
  };
}

export function normalizeListResponse<T = unknown>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

async function shouldRetryBootstrapResponse(response: Response): Promise<boolean> {
  if (response.status !== 202 && response.status !== 503) return false;
  const body = await response.clone().json().catch(() => null);
  const text = typeof body?.detail === 'string' || typeof body?.error === 'string'
    ? `${body.error || ''} ${body.detail || ''}`
    : '';
  return /bootstrap|Database is not ready/i.test(text);
}

export async function fetchWithBootstrapRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < BOOTSTRAP_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetch(input, init);
    if (!await shouldRetryBootstrapResponse(response) || attempt === BOOTSTRAP_RETRY_ATTEMPTS - 1) {
      return response;
    }
    await sleep(BOOTSTRAP_RETRY_DELAY_MS);
  }
  return fetch(input, init);
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { url, init } = buildApiRequest(path, options);
  const res = await fetch(url, init);

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function publicFetch<T = any>(path: string): Promise<T> {
  const res = await fetchWithBootstrapRetry(withApiBase(path));
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return res.json();
}
