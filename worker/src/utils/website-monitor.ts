import {
  buildWebsiteAlertNotification,
  buildWebsiteRecoveryNotification,
} from './notification-templates.ts';

export type WebsiteMonitorStatus = 'pending' | 'up' | 'down' | 'paused';
export type WebsiteMonitorMethod = 'GET' | 'HEAD' | 'TCP';
export type WebsiteAgentProbeMode = 'off' | 'selected' | 'country_auto';

export interface WebsiteMonitorInput {
  name: string;
  url: string;
  method: WebsiteMonitorMethod;
  expected_status_min: number;
  expected_status_max: number;
  interval_sec: number;
  timeout_sec: number;
  grace_period_sec: number;
  enabled: boolean;
  hidden: boolean;
  agent_probe_mode: WebsiteAgentProbeMode;
  agent_probe_clients: string[];
  agent_probe_limit: number;
  agent_probe_status_enabled: boolean;
}

export type WebsiteMonitorValidationResult =
  | { ok: true; value: WebsiteMonitorInput }
  | { ok: false; error: string };

export interface WebsiteFetchNormalizationInput {
  status?: number;
  latencyMs: number;
  min: number;
  max: number;
  error?: unknown;
}

export interface WebsiteFetchResult {
  ok: boolean;
  effective_status: 'up' | 'down';
  effective_reason: string;
  status_code: number | null;
  raw_status_code: number | null;
  latency_ms: number;
  error: string | null;
}

export type WebsiteProbeMonitor = {
  id: number;
  url: string;
  method: WebsiteMonitorMethod;
  timeout_sec: number;
  expected_status_min: number;
  expected_status_max: number;
};

type MaybeDueMonitor = {
  enabled: boolean;
  interval_sec: number;
  last_checked_at: string | null;
};

type MaybeAlertMonitor = {
  status: string;
  grace_period_sec: number;
  down_since: string | null;
  last_notified_at: string | null;
};

const IPV4_BLOCKS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^(22[4-9]|23\d)\./,
];

const REACHABLE_CHALLENGE_STATUSES = new Set([401, 403, 405, 412, 429]);
const WEBSITE_CHECK_DUE_TOLERANCE_SECONDS = 30;
const WEBSITE_PROBE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CF-VPS-Monitor/2.0; +https://cf-vps-monitor.local)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

type TcpSocket = {
  opened: Promise<unknown>;
  close(): Promise<void> | void;
};

type TcpConnector = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'off'; allowHalfOpen: false },
) => TcpSocket;

function integerInRange(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function parseIPv4(host: string): number[] | null {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host)) return null;
  const parts = host.split('.').map(part => Number(part));
  return parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isAmbiguousNumericHost(host: string): boolean {
  if (host.includes(':')) return false;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every(part => /^(0x[0-9a-f]+|\d+)$/i.test(part))) return false;
  if (parts.length !== 4) return true;
  return parts.some(part => /^0x/i.test(part) || (part.length > 1 && part.startsWith('0'))) || !parseIPv4(host);
}

function isBlockedIPv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isIPv4MappedIPv6(host: string): boolean {
  return /^(::ffff:|0:0:0:0:0:ffff:)/.test(host);
}

function isUnsafeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  if (isAmbiguousNumericHost(host)) return true;
  const ipv4 = parseIPv4(host);
  if (ipv4) return isBlockedIPv4(ipv4);
  if (IPV4_BLOCKS.some(pattern => pattern.test(host))) return true;
  if (isIPv4MappedIPv6(host)) return true;
  if (host === '::' || host === '::1') return true;
  if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(host)) return true;
  if (/^100(:|$)/.test(host) || /^2001:db8(:|$)/.test(host)) return true;
  return false;
}

function validateWebsiteUrl(parsed: URL): string | null {
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'invalid_protocol';
  if (parsed.username || parsed.password) return 'url_credentials_not_allowed';
  if (parsed.hash) return 'url_fragment_not_allowed';
  if (isUnsafeHostname(parsed.hostname)) return 'unsafe_host';
  return null;
}

function validateTcpUrl(parsed: URL): string | null {
  if (parsed.protocol !== 'tcp:') return 'invalid_protocol';
  if (parsed.username || parsed.password) return 'url_credentials_not_allowed';
  if (parsed.hash || parsed.search || (parsed.pathname && parsed.pathname !== '/')) return 'invalid_url';
  if (isUnsafeHostname(parsed.hostname)) return 'unsafe_host';
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'invalid_port';
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= 100) break;
  }
  return result;
}

export function validateWebsiteMonitorInput(input: Record<string, unknown>): WebsiteMonitorValidationResult {
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) return { ok: false, error: 'invalid_name' };

  let parsed: URL;
  try {
    parsed = new URL(String(input.url || '').trim());
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  const method = input.method === 'TCP' ? 'TCP' : input.method === 'HEAD' ? 'HEAD' : input.method === 'GET' || !input.method ? 'GET' : null;
  if (!method) return { ok: false, error: 'invalid_method' };

  const urlError = method === 'TCP' ? validateTcpUrl(parsed) : validateWebsiteUrl(parsed);
  if (urlError) return { ok: false, error: urlError };

  const expected_status_min = integerInRange(input.expected_status_min ?? 200, 100, 599);
  const expected_status_max = integerInRange(input.expected_status_max ?? 399, 100, 599);
  const interval_sec = integerInRange(input.interval_sec ?? 120, 60, 86400);
  const timeout_sec = integerInRange(input.timeout_sec ?? 10, 1, 30);
  const grace_period_sec = integerInRange(input.grace_period_sec ?? 180, 30, 86400);
  const agent_probe_mode: WebsiteAgentProbeMode =
    input.agent_probe_mode === 'selected' || input.agent_probe_mode === 'country_auto' ? input.agent_probe_mode : 'off';
  const agent_probe_limit = integerInRange(input.agent_probe_limit ?? 3, 1, 10);

  if (
    expected_status_min === null ||
    expected_status_max === null ||
    expected_status_min > expected_status_max ||
    interval_sec === null ||
    timeout_sec === null ||
    timeout_sec > interval_sec ||
    grace_period_sec === null ||
    agent_probe_limit === null
  ) {
    return { ok: false, error: 'invalid_bounds' };
  }

  return {
    ok: true,
    value: {
      name,
      url: parsed.toString(),
      method,
      expected_status_min,
      expected_status_max,
      interval_sec,
      timeout_sec,
      grace_period_sec,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
      hidden: typeof input.hidden === 'boolean' ? input.hidden : false,
      agent_probe_mode,
      agent_probe_clients: readStringArray(input.agent_probe_clients),
      agent_probe_limit,
      agent_probe_status_enabled: typeof input.agent_probe_status_enabled === 'boolean' ? input.agent_probe_status_enabled : true,
    },
  };
}

export function normalizeWebsiteFetchResult(input: WebsiteFetchNormalizationInput): WebsiteFetchResult {
  const latency_ms = Math.max(0, Math.round(input.latencyMs));
  if (typeof input.status === 'number') {
    const inRange = input.status >= input.min && input.status <= input.max;
    // ponytail: this is availability monitoring, not content verification. Some large sites return
    // WAF/login/challenge statuses to Worker probes while the site is reachable; add exact status
    // code lists later if this grows beyond the default HTTP monitor.
    const challengeReachable = input.min === 200 && input.max === 399 && REACHABLE_CHALLENGE_STATUSES.has(input.status);
    const ok = inRange || challengeReachable;
    return {
      ok,
      effective_status: ok ? 'up' : 'down',
      effective_reason: inRange ? 'status_in_expected_range' : challengeReachable ? 'reachable_challenge' : 'http_status_mismatch',
      status_code: input.status,
      raw_status_code: input.status,
      latency_ms,
      error: ok ? null : `http_${input.status}`,
    };
  }

  const message = input.error instanceof Error ? input.error.message.toLowerCase() : String(input.error || '').toLowerCase();
  const error = /unsafe_redirect/.test(message)
    ? 'unsafe_redirect'
    : /unsafe_host/.test(message)
      ? 'unsafe_host'
      : /abort|timeout|timed out/.test(message)
        ? 'timeout'
        : /enotfound|dns|getaddrinfo/.test(message)
          ? 'dns_error'
          : /certificate|tls|ssl/.test(message)
            ? 'tls_error'
            : 'network_error';
  return {
    ok: false,
    effective_status: 'down',
    effective_reason: error,
    status_code: null,
    raw_status_code: null,
    latency_ms,
    error,
  };
}

export async function checkWebsiteMonitorTcp(monitor: WebsiteProbeMonitor, connector?: TcpConnector): Promise<{
  monitor_id: number;
  checked_at: string;
  ok: boolean;
  effective_status: 'up' | 'down';
  effective_reason: string;
  status_code: number | null;
  raw_status_code: number | null;
  latency_ms: number;
  error: string | null;
}> {
  const started = Date.now();
  const checkedAt = new Date(started).toISOString();
  let socket: TcpSocket | null = null;

  try {
    const url = new URL(monitor.url);
    const urlError = validateTcpUrl(url);
    if (urlError) throw new Error(urlError);
    const connect = connector || ((await import('cloudflare:sockets')).connect as TcpConnector);
    socket = connect(
      { hostname: url.hostname, port: Number(url.port) },
      { secureTransport: 'off', allowHalfOpen: false },
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('timeout')), Math.max(1, monitor.timeout_sec) * 1000);
    });
    await Promise.race([socket.opened, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    await socket.close();
    const latency_ms = Math.max(0, Math.round(Date.now() - started));
    return {
      monitor_id: monitor.id,
      checked_at: checkedAt,
      ok: true,
      effective_status: 'up',
      effective_reason: 'tcp_connect',
      status_code: null,
      raw_status_code: null,
      latency_ms,
      error: null,
    };
  } catch (error) {
    try { await socket?.close(); } catch {}
    const normalized = normalizeWebsiteFetchResult({
      latencyMs: Date.now() - started,
      min: monitor.expected_status_min,
      max: monitor.expected_status_max,
      error,
    });
    return {
      monitor_id: monitor.id,
      checked_at: checkedAt,
      ok: false,
      effective_status: 'down',
      effective_reason: normalized.effective_reason,
      status_code: null,
      raw_status_code: null,
      latency_ms: normalized.latency_ms,
      error: normalized.error,
    };
  }
}

export async function checkWebsiteMonitorHttp(monitor: WebsiteProbeMonitor): Promise<{
  monitor_id: number;
  checked_at: string;
  ok: boolean;
  effective_status: 'up' | 'down';
  effective_reason: string;
  status_code: number | null;
  raw_status_code: number | null;
  latency_ms: number;
  error: string | null;
}> {
  if (monitor.method === 'TCP') return checkWebsiteMonitorTcp(monitor);

  const started = Date.now();
  const checkedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, monitor.timeout_sec) * 1000);

  try {
    const url = new URL(monitor.url);
    const initialUrlError = validateWebsiteUrl(url);
    if (initialUrlError) throw new Error(initialUrlError);

    const response = await fetch(url.toString(), {
      method: monitor.method,
      redirect: 'manual',
      signal: controller.signal,
      headers: WEBSITE_PROBE_HEADERS,
    });
    const location = response.headers.get('Location');
    if (location && response.status >= 300 && response.status <= 399) {
      const nextUrl = new URL(location, url);
      const redirectUrlError = validateWebsiteUrl(nextUrl);
      if (redirectUrlError) throw new Error('unsafe_redirect');
    }

    if (response.body) await response.body.cancel().catch(() => undefined);
    const normalized = normalizeWebsiteFetchResult({
      status: response.status,
      latencyMs: Date.now() - started,
      min: monitor.expected_status_min,
      max: monitor.expected_status_max,
    });
    return {
      monitor_id: monitor.id,
      checked_at: checkedAt,
      ok: normalized.ok,
      effective_status: normalized.effective_status,
      effective_reason: normalized.effective_reason,
      status_code: normalized.status_code,
      raw_status_code: normalized.raw_status_code,
      latency_ms: normalized.latency_ms,
      error: normalized.error,
    };
  } catch (error) {
    const normalized = normalizeWebsiteFetchResult({
      latencyMs: Date.now() - started,
      min: monitor.expected_status_min,
      max: monitor.expected_status_max,
      error,
    });
    return {
      monitor_id: monitor.id,
      checked_at: checkedAt,
      ok: normalized.ok,
      effective_status: normalized.effective_status,
      effective_reason: normalized.effective_reason,
      status_code: normalized.status_code,
      raw_status_code: normalized.raw_status_code,
      latency_ms: normalized.latency_ms,
      error: normalized.error,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function isWebsiteCheckDue(monitor: MaybeDueMonitor, now = new Date()): boolean {
  if (!monitor.enabled) return false;
  if (!monitor.last_checked_at) return true;
  return now.getTime() - new Date(monitor.last_checked_at).getTime() >= Math.max(1, monitor.interval_sec - WEBSITE_CHECK_DUE_TOLERANCE_SECONDS) * 1000;
}

export function shouldNotifyWebsiteDown(monitor: MaybeAlertMonitor, now = new Date()): boolean {
  if (monitor.status !== 'down' || monitor.last_notified_at || !monitor.down_since) return false;
  return now.getTime() - new Date(monitor.down_since).getTime() >= monitor.grace_period_sec * 1000;
}

export function shouldNotifyWebsiteRecovery(monitor: { status: string; last_notified_at: string | null }): boolean {
  return monitor.status === 'up' && Boolean(monitor.last_notified_at);
}

export function buildWebsiteAlertMessage(input: {
  name: string;
  url: string;
  downMinutes: number;
  lastStatus: string;
  checkedAt: string;
}): string {
  return buildWebsiteAlertNotification(input).body;
}

export function buildWebsiteRecoveryMessage(input: {
  name: string;
  url: string;
  downMinutes: number;
  statusCode: number | null;
  latencyMs: number | null;
}): string {
  return buildWebsiteRecoveryNotification(input).body;
}
