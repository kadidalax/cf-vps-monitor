const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;
const TEXT_LIMITS: Record<string, number> = {
  name: 128,
  cpu_name: 256,
  virtualization: 128,
  arch: 64,
  os: 128,
  kernel_version: 128,
  gpu_name: 256,
  ipv4: 128,
  ipv6: 128,
  region: 128,
  remark: 1000,
  public_remark: 1000,
  version: 128,
  currency: 16,
  expired_at: 64,
  group: 128,
};
const TEXT_FIELDS = new Set(Object.keys(TEXT_LIMITS));
const BOOLEAN_FIELDS = new Set(['auto_renewal', 'hidden']);
const INTEGER_FIELDS = new Set(['cpu_cores', 'billing_cycle', 'mem_total', 'swap_total', 'disk_total', 'traffic_limit']);
const NUMBER_FIELDS = new Set(['price']);
const TRAFFIC_LIMIT_TYPES = new Set(['sum', 'max', 'min', 'up', 'down', 'unlimited']);
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 64;
const MAX_TAGS_TEXT_LENGTH = 1000;
const AGENT_TOKEN_BYTES = 32;
const MIN_AGENT_TOKEN_LENGTH = 32;
const MAX_AGENT_TOKEN_LENGTH = 256;
const AGENT_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;
const AGENT_TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;

type ClientUpdateValidationResult =
  | { ok: true; client: Record<string, unknown> }
  | { ok: false; errors: string[] };

type ClientCreateValidationResult =
  | { ok: true; client: { uuid: string; token: string; name: string } }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, field: string, maxLength: number, errors: string[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    errors.push(`${field} 必须是字符串`);
    return undefined;
  }
  const text = String(value).trim();
  if (text.length > maxLength) {
    errors.push(`${field} 不能超过 ${maxLength} 字符`);
    return undefined;
  }
  return text;
}

function readBoolean(value: unknown, field: string, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  errors.push(`${field} 必须是 true/false/1/0`);
  return undefined;
}

function numericBounds(field: string): { min: number; max: number } {
  switch (field) {
    case 'price':
      return { min: -1, max: 1_000_000_000 };
    case 'cpu_cores':
      return { min: 0, max: 1024 };
    case 'billing_cycle':
      return { min: -1, max: 36_500 };
    case 'traffic_limit':
    case 'mem_total':
    case 'swap_total':
    case 'disk_total':
      return { min: 0, max: MAX_SAFE_BYTES };
    default:
      return { min: 0, max: MAX_SAFE_BYTES };
  }
}

function readNumber(value: unknown, field: string, integer: boolean, errors: string[]): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numberValue = typeof value === 'number' ? value : Number(String(value).trim());
  const { min, max } = numericBounds(field);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    errors.push(`${field} 必须在 ${min} 到 ${max} 之间`);
    return undefined;
  }
  if (integer && !Number.isInteger(numberValue)) {
    errors.push(`${field} 必须是整数`);
    return undefined;
  }
  return numberValue;
}

function normalizeTags(value: unknown, errors: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  const source = Array.isArray(value) ? value : String(value).split(/[;,]/);
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      errors.push('tags 必须是字符串或字符串数组');
      return undefined;
    }
    const tag = String(item).trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      errors.push(`单个标签不能超过 ${MAX_TAG_LENGTH} 字符`);
      continue;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }

  if (tags.length > MAX_TAGS) {
    errors.push(`标签数量不能超过 ${MAX_TAGS} 个`);
  }

  const normalized = tags.slice(0, MAX_TAGS).join(';');
  if (normalized.length > MAX_TAGS_TEXT_LENGTH) {
    errors.push(`tags 不能超过 ${MAX_TAGS_TEXT_LENGTH} 字符`);
    return undefined;
  }
  return normalized;
}

function normalizeTrafficLimitType(value: unknown, errors: string[]): string | undefined {
  const text = readString(value, 'traffic_limit_type', 64, errors);
  if (text === undefined) return undefined;
  if (text === null || text === '') return 'sum';
  if (TRAFFIC_LIMIT_TYPES.has(text)) return text;
  if (/^bandwidth:\d+(?:\.\d+)?(?:Mbps|Gbps)$/i.test(text)) {
    return text.replace(/(mbps|gbps)$/i, (unit) => unit.toLowerCase() === 'gbps' ? 'Gbps' : 'Mbps');
  }
  errors.push('traffic_limit_type 无效');
  return undefined;
}

function readIdentifier(value: unknown, field: string, fallback: string, errors: string[]): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串`);
    return fallback;
  }

  const text = value.trim();
  if (text.length < 1 || text.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    errors.push(`${field} 只能包含字母、数字、点、下划线、冒号和连字符，长度 1-128`);
    return fallback;
  }
  return text;
}

export function generateAgentToken(): string {
  const bytes = new Uint8Array(AGENT_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function isAgentTokenHash(token: string): boolean {
  return AGENT_TOKEN_HASH_PATTERN.test(token.trim());
}

export function isAgentTokenShape(token: string): boolean {
  return !isAgentTokenHash(token)
    && token.length >= MIN_AGENT_TOKEN_LENGTH
    && token.length <= MAX_AGENT_TOKEN_LENGTH
    && AGENT_TOKEN_PATTERN.test(token);
}

function readToken(value: unknown, fallback: string, errors: string[]): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    errors.push('token 必须是字符串');
    return fallback;
  }

  const text = value.trim();
  if (!isAgentTokenShape(text)) {
    errors.push('token 只能包含字母、数字、点、下划线、冒号和连字符，长度 32-256，且不能是 sha256 哈希格式');
    return fallback;
  }
  return text;
}

export function validateClientCreateInput(input: unknown): ClientCreateValidationResult {
  if (!isObject(input)) {
    return { ok: false, errors: ['客户端数据必须是对象'] };
  }

  const errors: string[] = [];
  const allowedFields = new Set(['uuid', 'token', 'name']);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      errors.push(`不允许创建字段: ${field}`);
    }
  }

  const uuid = readIdentifier(input.uuid, 'uuid', crypto.randomUUID(), errors);
  const token = readToken(input.token, generateAgentToken(), errors);
  const name = readString(input.name, 'name', TEXT_LIMITS.name, errors) || '未命名服务器';

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, client: { uuid, token, name } };
}

export function validateClientUpdateInput(input: unknown): ClientUpdateValidationResult {
  if (!isObject(input)) {
    return { ok: false, errors: ['客户端数据必须是对象'] };
  }

  const errors: string[] = [];
  const client: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(input)) {
    if (field === 'uuid' || field === 'token') continue;

    if (TEXT_FIELDS.has(field)) {
      const normalized = readString(value, field, TEXT_LIMITS[field], errors);
      if (normalized !== undefined) client[field] = normalized;
      continue;
    }

    if (field === 'tags') {
      const normalized = normalizeTags(value, errors);
      if (normalized !== undefined) client.tags = normalized;
      continue;
    }

    if (field === 'traffic_limit_type') {
      const normalized = normalizeTrafficLimitType(value, errors);
      if (normalized !== undefined) client.traffic_limit_type = normalized;
      continue;
    }

    if (BOOLEAN_FIELDS.has(field)) {
      const normalized = readBoolean(value, field, errors);
      if (normalized !== undefined) client[field] = normalized;
      continue;
    }

    if (INTEGER_FIELDS.has(field)) {
      const normalized = readNumber(value, field, true, errors);
      if (normalized !== undefined) client[field] = normalized;
      continue;
    }

    if (NUMBER_FIELDS.has(field)) {
      const normalized = readNumber(value, field, false, errors);
      if (normalized !== undefined) client[field] = normalized;
      continue;
    }

    errors.push(`不允许修改字段: ${field}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, client };
}
