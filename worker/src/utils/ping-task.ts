import type { PingTask } from '../db/queries';

export const PING_TASK_TYPES = ['icmp', 'tcp', 'http'] as const;
export const MIN_PING_INTERVAL_SEC = 60;
export const MAX_PING_INTERVAL_SEC = 86_400;
export const MAX_PING_TASK_NAME_LENGTH = 128;
export const MAX_PING_TARGET_LENGTH = 512;
export const MAX_PING_TASK_CLIENTS = 500;

type PingTaskType = typeof PING_TASK_TYPES[number];

type ValidationResult =
  | { ok: true; task: PingTask }
  | { ok: false; errors: string[] };

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isPingTaskType(value: string): value is PingTaskType {
  return (PING_TASK_TYPES as readonly string[]).includes(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function readStringArray(value: unknown): string[] {
  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= MAX_PING_TASK_CLIENTS) break;
  }
  return result;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  if (parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(part => Number(part));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function isAmbiguousNumericHost(host: string): boolean {
  if (host.includes(':')) return false;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every(part => /^(0x[0-9a-f]+|\d+)$/i.test(part))) return false;
  if (parts.length !== 4) return true;
  return parts.some(part => /^0x/i.test(part) || (part.length > 1 && part.startsWith('0'))) || !parseIpv4(host);
}

function isBlockedIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('0:0:0:0:0:ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function validateNetworkBoundary(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return '目标必须包含 host';
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return 'Ping 目标不能指向 localhost';
  }
  if (normalized === 'metadata.google.internal') {
    return 'Ping 目标不能指向云厂商 metadata 地址';
  }
  if (isAmbiguousNumericHost(normalized)) {
    return 'Ping 目标不能使用内网、环回、链路本地或保留 IP';
  }
  if (isBlockedIpv4(normalized) || isBlockedIpv6(normalized)) {
    return 'Ping 目标不能使用内网、环回、链路本地或保留 IP';
  }
  return null;
}

function validateTcpTarget(target: string): string | null {
  if (target.includes('://')) return 'TCP 目标必须使用 host:port 格式';
  if (/\s/.test(target)) return 'TCP 目标不能包含空白字符';

  try {
    const url = new URL(`tcp://${target}`);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return 'TCP 目标必须包含 1-65535 范围内的端口';
    }
    const boundaryError = validateNetworkBoundary(url.hostname);
    if (boundaryError) return boundaryError;
    return null;
  } catch {
    return 'TCP 目标必须使用 host:port 格式';
  }
}

function validateHttpTarget(target: string): string | null {
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'HTTP 目标必须使用 http:// 或 https://';
    }
    if (!url.hostname) return 'HTTP 目标必须包含 host';
    if (url.username || url.password) return 'HTTP 目标不能包含用户名或密码';
    const boundaryError = validateNetworkBoundary(url.hostname);
    if (boundaryError) return boundaryError;
    return null;
  } catch {
    return 'HTTP 目标必须是有效 URL';
  }
}

function validateIcmpTarget(target: string): string | null {
  if (/\s/.test(target)) return 'ICMP 目标不能包含空白字符';
  if (target.includes('://')) return 'ICMP 目标必须是主机名或 IP';
  if (/^\[[^\]]+\]:.+$/.test(target) || (target.match(/:/g) || []).length === 1) {
    return 'ICMP 目标不能包含端口，请仅填写域名或 IP';
  }
  const boundaryError = validateNetworkBoundary(target);
  if (boundaryError) return boundaryError;
  return null;
}

function validateTarget(type: PingTaskType, target: string): string | null {
  if (!target) return '目标地址不能为空';
  if (target.length > MAX_PING_TARGET_LENGTH) return `目标地址不能超过 ${MAX_PING_TARGET_LENGTH} 字符`;

  switch (type) {
    case 'tcp':
      return validateTcpTarget(target);
    case 'http':
      return validateHttpTarget(target);
    case 'icmp':
      return validateIcmpTarget(target);
  }
}

export function validatePingTaskInput(
  input: unknown,
  allowedClientIds?: Set<string>,
): ValidationResult {
  const body = asObject(input);
  const errors: string[] = [];

  const name = String(body.name ?? '').trim();
  if (!name) {
    errors.push('任务名称不能为空');
  } else if (name.length > MAX_PING_TASK_NAME_LENGTH) {
    errors.push(`任务名称不能超过 ${MAX_PING_TASK_NAME_LENGTH} 字符`);
  }

  const typeValue = String(body.type ?? 'icmp').trim().toLowerCase();
  if (!isPingTaskType(typeValue)) {
    errors.push('Ping 类型必须是 icmp、tcp 或 http');
  }
  const type: PingTaskType = isPingTaskType(typeValue) ? typeValue : 'icmp';

  const target = String(body.target ?? '').trim();
  const targetError = validateTarget(type, target);
  if (targetError) errors.push(targetError);

  const intervalValue = Number(body.interval_sec ?? body.interval ?? 60);
  if (
    !Number.isInteger(intervalValue) ||
    intervalValue < MIN_PING_INTERVAL_SEC ||
    intervalValue > MAX_PING_INTERVAL_SEC
  ) {
    errors.push(`检测间隔必须是 ${MIN_PING_INTERVAL_SEC} 到 ${MAX_PING_INTERVAL_SEC} 秒之间的整数`);
  }
  const intervalSec = Number.isInteger(intervalValue) ? intervalValue : 60;

  const allClients = readBoolean(body.all_clients, false);
  const clients = allClients ? [] : readStringArray(body.clients);
  if (!allClients && clients.length === 0) {
    errors.push('定向任务至少需要绑定一个客户端');
  }

  if (allowedClientIds && clients.some(client => !allowedClientIds.has(client))) {
    errors.push('任务包含不存在的客户端');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    task: {
      name,
      clients,
      all_clients: allClients,
      type,
      target,
      interval_sec: intervalSec,
    },
  };
}
