import type { NotificationMessage } from './notification-templates.ts';

export const WEBHOOK_MESSAGE_MAX_CHARS = 4000;
export const WEBHOOK_DISCORD_MAX_CHARS = 1900;
export const WEBHOOK_RESPONSE_ERROR_MAX_CHARS = 1024;
export const WEBHOOK_TIMEOUT_MS = 5000;

export type WebhookFormat = 'generic' | 'slack' | 'discord' | 'feishu' | 'dingtalk' | 'wecom' | 'custom';

export type WebhookConfig = {
  url: string;
  format: WebhookFormat;
  secret?: string;
  method?: 'GET' | 'POST' | string;
  contentType?: string;
  headersJson?: string;
  bodyTemplate?: string;
  username?: string;
  password?: string;
  retryCount?: number;
  nowMs?: number;
};

export type WebhookSendResult =
  | { ok: true; status: number; host: string }
  | { ok: false; status?: number; host?: string; error: string };

type WebhookRequest = {
  url: string;
  host: string;
  method: 'GET' | 'POST';
  body?: string;
  headers: Record<string, string>;
};

type WebhookIo = {
  fetch?: typeof fetch;
};

function errorDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? '');
  return value.replace(/\s+/g, ' ').trim().slice(0, 700);
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
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isIPv4MappedIPv6(host: string): boolean {
  return /^(::ffff:|0:0:0:0:0:ffff:)/.test(host);
}

function isUnsafeWebhookHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '169.254.169.254' || host === 'fd00:ec2::254') return true;
  if (isAmbiguousNumericHost(host)) return true;
  const ipv4 = parseIPv4(host);
  if (ipv4) return isBlockedIPv4(ipv4);
  if (isIPv4MappedIPv6(host)) return true;
  if (host === '::' || host === '::1') return true;
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(host)) return true;
  return false;
}

export function validateWebhookUrl(rawUrl: string): { ok: true; url: string; host: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'invalid_protocol' };
  if (!url.hostname) return { ok: false, error: 'invalid_host' };
  if (url.username || url.password) return { ok: false, error: 'url_credentials_not_allowed' };
  if (isUnsafeWebhookHostname(url.hostname)) return { ok: false, error: 'unsafe_host' };
  return { ok: true, url: url.toString(), host: url.hostname.toLowerCase() };
}

function truncateMessage(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha256(secret: string, payload = ''): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

function templateValues(notification: NotificationMessage, nowMs: number): Record<string, string> {
  return {
    title: notification.subject || '',
    message: notification.body || '',
    event: notification.event || '',
    client: notification.clients || '',
    time: notification.time || new Date(nowMs).toISOString(),
    emoji: notification.emoji || '',
    source: 'cf-vps-monitor',
  };
}

function jsonTemplateEscape(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

function renderWebhookTemplate(
  template: string,
  values: Record<string, string>,
  mode: 'plain' | 'json' | 'url' = 'plain',
): string {
  return template.replace(/\{\{(title|message|event|client|time|emoji|source)\}\}/g, (_match, key: string) => {
    const value = values[key] || '';
    if (mode === 'json') return jsonTemplateEscape(value);
    if (mode === 'url') return encodeURIComponent(value);
    return value;
  });
}

function isJsonContentType(value: string): boolean {
  return value.toLowerCase().includes('application/json');
}

function parseWebhookHeaders(headersJson?: string): Record<string, string> {
  const raw = String(headersJson || '').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid_headers_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('headers_json_must_be_object');
  }

  const forbidden = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || typeof value !== 'string') throw new Error('invalid_header_value');
    const normalizedKey = key.trim();
    if (!normalizedKey || /[\r\n:]/.test(normalizedKey)) throw new Error('invalid_header_name');
    const lowerKey = normalizedKey.toLowerCase();
    if (forbidden.has(lowerKey)) throw new Error(`forbidden_header:${lowerKey}`);
    if (lowerKey === 'content-type') continue;
    if (/[\r\n]/.test(value)) throw new Error('invalid_header_value');
    headers[normalizedKey] = value;
  }
  return headers;
}

function addBasicAuthHeader(headers: Record<string, string>, username?: string, password?: string): void {
  if (!username && !password) return;
  if (!username || !password) throw new Error('basic_auth_incomplete');
  if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
    throw new Error('authorization_conflict');
  }
  headers.Authorization = `Basic ${bytesToBase64(new TextEncoder().encode(`${username}:${password}`))}`;
}

function normalizedWebhookMethod(value?: string): 'GET' | 'POST' {
  return String(value || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
}

function normalizedRetryCount(value?: number): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 3 ? count : 1;
}

function buildCustomWebhookRequest(config: WebhookConfig, notification: NotificationMessage, nowMs: number): WebhookRequest {
  const method = normalizedWebhookMethod(config.method);
  const values = templateValues(notification, nowMs);
  const headers = parseWebhookHeaders(config.headersJson);
  addBasicAuthHeader(headers, config.username, config.password);

  if (method === 'GET') {
    const renderedUrl = renderWebhookTemplate(config.url, values, 'url');
    const validated = validateWebhookUrl(renderedUrl);
    if (!validated.ok) throw new Error(validated.error);
    return { url: validated.url, host: validated.host, method, headers };
  }

  const validated = validateWebhookUrl(config.url);
  if (!validated.ok) throw new Error(validated.error);
  const contentType = config.contentType || 'application/json';
  const bodyTemplate = config.bodyTemplate || '{"message":"{{message}}","title":"{{title}}"}';
  const body = renderWebhookTemplate(bodyTemplate, values, isJsonContentType(contentType) ? 'json' : 'plain');
  headers['Content-Type'] = contentType;
  return { url: validated.url, host: validated.host, method, body, headers };
}

export async function buildWebhookRequest(config: WebhookConfig, notification: NotificationMessage): Promise<WebhookRequest> {
  const nowMs = config.nowMs ?? Date.now();
  if (config.format === 'custom') return buildCustomWebhookRequest(config, notification, nowMs);

  const validated = validateWebhookUrl(config.url);
  if (!validated.ok) throw new Error(validated.error);

  const timestamp = Math.floor(nowMs / 1000).toString();
  const text = truncateMessage(notification.body, config.format === 'discord' ? WEBHOOK_DISCORD_MAX_CHARS : WEBHOOK_MESSAGE_MAX_CHARS);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let requestUrl = validated.url;
  let bodyObject: unknown;

  switch (config.format) {
    case 'slack':
      bodyObject = { text };
      break;
    case 'discord':
      bodyObject = { content: text, allowed_mentions: { parse: [] } };
      break;
    case 'feishu':
      bodyObject = { msg_type: 'text', content: { text } };
      if (config.secret) {
        bodyObject = {
          ...bodyObject as Record<string, unknown>,
          timestamp,
          sign: bytesToBase64(await hmacSha256(`${timestamp}\n${config.secret}`)),
        };
      }
      break;
    case 'dingtalk':
      bodyObject = { msgtype: 'text', text: { content: text } };
      if (config.secret) {
        const milliseconds = String(nowMs);
        const url = new URL(validated.url);
        url.searchParams.set('timestamp', milliseconds);
        url.searchParams.set('sign', bytesToBase64(await hmacSha256(config.secret, `${milliseconds}\n${config.secret}`)));
        requestUrl = url.toString();
      }
      break;
    case 'wecom':
      bodyObject = { msgtype: 'text', text: { content: text } };
      break;
    default:
      bodyObject = {
        source: 'cf-vps-monitor',
        subject: truncateMessage(notification.subject, 240),
        message: text,
        event_time: new Date(nowMs).toISOString(),
      };
      break;
  }

  const body = JSON.stringify(bodyObject);
  if (config.format === 'generic' && config.secret) {
    headers['X-CFVM-Timestamp'] = timestamp;
    headers['X-CFVM-Signature'] = `sha256=${bytesToHex(await hmacSha256(config.secret, `${timestamp}.${body}`))}`;
  }

  return { url: requestUrl, host: validated.host, method: 'POST', body, headers };
}

function normalizeErrorBodyText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, WEBHOOK_RESPONSE_ERROR_MAX_CHARS);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < WEBHOOK_RESPONSE_ERROR_MAX_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = WEBHOOK_RESPONSE_ERROR_MAX_CHARS - size;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      size += chunk.byteLength;
      if (value.byteLength > remaining) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return normalizeErrorBodyText(new TextDecoder().decode(bytes));
  } catch {
    return '';
  }
}

export async function sendWebhookMessage(
  config: WebhookConfig,
  notification: NotificationMessage,
  io: WebhookIo = {},
): Promise<WebhookSendResult> {
  let request: WebhookRequest;
  try {
    request = await buildWebhookRequest(config, notification);
  } catch (error) {
    return { ok: false, error: errorDetail(error) };
  }

  let lastResult: WebhookSendResult = { ok: false, host: request.host, error: 'not_sent' };
  for (let attempt = 0; attempt < normalizedRetryCount(config.retryCount); attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        redirect: 'manual',
        signal: controller.signal,
      };
      if (request.body !== undefined) init.body = request.body;
      const response = await (io.fetch || fetch)(request.url, init);
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, host: request.host };
      }
      const body = await readErrorBody(response);
      lastResult = {
        ok: false,
        status: response.status,
        host: request.host,
        error: `HTTP ${response.status}${body ? `: ${body}` : ''}`,
      };
    } catch (error) {
      lastResult = { ok: false, host: request.host, error: errorDetail(error) };
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return lastResult;
}
