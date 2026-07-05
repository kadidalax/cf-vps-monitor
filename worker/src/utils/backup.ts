import type {
  Client,
  ExpiryNotification,
  LoadNotification,
  LoadNotificationMetric,
  OfflineNotification,
  PingTask,
  WebsiteMonitor,
} from '../db/queries.ts';
import { sanitizeSettingsForStorage } from '../settings/schema.ts';
import { validatePingTaskInput } from './ping-task.ts';

export const BACKUP_SCHEMA_ID = 'cf-monitor.backup';
export const ENCRYPTED_BACKUP_SCHEMA_ID = 'cf-monitor.encrypted-backup';
export const BACKUP_VERSION = '2.0.0';
export const BACKUP_SCOPE = 'configuration';
export const BACKUP_SENSITIVE_WARNING = 'This backup may contain client tokens, AutoDiscovery Key, Telegram credentials, and other configuration secrets. Store it securely.';
export const BACKUP_ENCRYPTION_ALGORITHM = 'AES-GCM';
export const BACKUP_KDF = 'PBKDF2-SHA256';
export const BACKUP_KDF_ITERATIONS = 100_000;
export const BACKUP_SALT_BYTES = 16;
export const BACKUP_IV_BYTES = 12;
export const MIN_BACKUP_DECRYPT_PASSWORD_BYTES = 6;
export const MIN_BACKUP_ENCRYPT_PASSWORD_BYTES = 6;
export const MAX_BACKUP_PASSWORD_BYTES = 1024;
export const BACKUP_EXCLUDED_MODULES = [
  'users',
  'records',
  'gpu_records',
  'gpu_snapshots',
  'ping_records',
  'ping_snapshots',
  'audit_logs',
];
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

const MAX_CLIENTS = 1000;
const MAX_PING_TASKS = 1000;
const MAX_NOTIFICATIONS = 5000;

type BackupModuleKey =
  | 'settings'
  | 'clients'
  | 'ping_tasks'
  | 'offline_notifications'
  | 'expiry_notifications'
  | 'load_notifications';

export interface BackupData {
  schema?: string;
  version: string;
  scope?: string;
  timestamp?: string;
  excluded?: string[];
  sensitive?: boolean;
  warning?: string;
  settings?: Record<string, string>;
  clients?: Partial<Client>[];
  ping_tasks?: PingTask[];
  offline_notifications?: OfflineNotification[];
  expiry_notifications?: ExpiryNotification[];
  load_notifications?: LoadNotification[];
  website_monitors?: WebsiteMonitor[];
}

export interface EncryptedBackupData {
  schema: typeof ENCRYPTED_BACKUP_SCHEMA_ID;
  version: string;
  scope: typeof BACKUP_SCOPE;
  timestamp: string;
  encrypted: true;
  excluded: string[];
  encryption: {
    algorithm: typeof BACKUP_ENCRYPTION_ALGORITHM;
    kdf: typeof BACKUP_KDF;
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
}

export interface BackupSummary {
  settings: boolean;
  settings_count: number;
  clients: number;
  ping_tasks: number;
  offline_notifications: number;
  expiry_notifications: number;
  load_notifications: number;
  website_monitors: number;
}

export type BackupValidationResult =
  | { ok: true; backup: BackupData; warnings: string[] }
  | { ok: false; errors: string[] };

export type BackupDecryptResult =
  | { ok: true; backup: BackupData }
  | { ok: false; error: string };

export type BackupEncryptResult =
  | { ok: true; encryptedBackup: EncryptedBackupData }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function backupPasswordError(password: string, minBytes: number): string | null {
  if (!password) return '备份密码不能为空';
  if (Array.from(password).length < minBytes) {
    return `备份密码至少需要 ${minBytes} 位`;
  }
  const bytes = new TextEncoder().encode(password).byteLength;
  if (bytes > MAX_BACKUP_PASSWORD_BYTES) {
    return `备份密码不能超过 ${MAX_BACKUP_PASSWORD_BYTES} 字节`;
  }
  return null;
}

function encryptBackupPasswordError(password: string): string | null {
  const sizeError = backupPasswordError(password, MIN_BACKUP_ENCRYPT_PASSWORD_BYTES);
  if (sizeError) return sizeError;
  return null;
}

async function deriveBackupKey(password: string, salt: Uint8Array, usages: Array<'encrypt' | 'decrypt'>): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: BACKUP_KDF_ITERATIONS,
    },
    keyMaterial,
    {
      name: BACKUP_ENCRYPTION_ALGORITHM,
      length: 256,
    },
    false,
    usages,
  );
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function textField(
  value: unknown,
  field: string,
  errors: string[],
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) errors.push(`${field} 必填`);
    return undefined;
  }

  const text = toText(value);
  if (text === null) {
    errors.push(`${field} 必须是字符串`);
    return undefined;
  }
  if (options.maxLength !== undefined && text.length > options.maxLength) {
    errors.push(`${field} 超过最大长度 ${options.maxLength}`);
    return undefined;
  }
  if (options.required && text.trim() === '') {
    errors.push(`${field} 不能为空`);
    return undefined;
  }
  return text;
}

function numberField(
  value: unknown,
  field: string,
  errors: string[],
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numberValue = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    errors.push(`${field} 必须在 ${min} 到 ${max} 之间`);
    return fallback;
  }
  return numberValue;
}

function integerField(
  value: unknown,
  field: string,
  errors: string[],
  fallback: number,
  min: number,
  max: number,
): number {
  const numberValue = numberField(value, field, errors, fallback, min, max);
  if (!Number.isInteger(numberValue)) {
    errors.push(`${field} 必须是整数`);
    return fallback;
  }
  return numberValue;
}

function booleanField(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function stringArrayField(value: unknown, field: string, errors: string[], maxItems: number): string[] {
  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      errors.push(`${field} 必须是字符串数组`);
      return [];
    }
  }

  if (source === undefined || source === null) return [];
  if (!Array.isArray(source)) {
    errors.push(`${field} 必须是数组`);
    return [];
  }
  if (source.length > maxItems) {
    errors.push(`${field} 超过最大数量 ${maxItems}`);
  }

  return source
    .slice(0, maxItems)
    .map((item) => textField(item, field, errors, { maxLength: 128 }))
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function optionalTimeField(value: unknown, field: string, errors: string[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  return textField(value, field, errors, { maxLength: 64 }) ?? null;
}

function requireArray(
  body: Record<string, unknown>,
  key: BackupModuleKey,
  maxItems: number,
  errors: string[],
): unknown[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${key} 必须是数组`);
    return undefined;
  }
  if (value.length > maxItems) {
    errors.push(`${key} 超过最大数量 ${maxItems}`);
  }
  return value.slice(0, maxItems);
}

function validateClients(items: unknown[], errors: string[]): Partial<Client>[] {
  const clients: Partial<Client>[] = [];
  const uuids = new Set<string>();
  const tokens = new Set<string>();
  const tokenHashes = new Set<string>();

  const stringFields = [
    'uuid', 'token', 'token_hash', 'name', 'cpu_name', 'virtualization', 'arch', 'os',
    'kernel_version', 'gpu_name', 'ipv4', 'ipv6', 'region', 'remark',
    'public_remark', 'version', 'currency', 'expired_at', 'group', 'tags',
    'traffic_limit_type', 'token_last_used_at', 'token_last_used_ip', 'token_rotated_at', 'created_at', 'updated_at',
  ];
  const numberFields = [
    'cpu_cores', 'mem_total', 'swap_total', 'disk_total', 'price',
    'billing_cycle', 'traffic_limit', 'sort_order',
  ];
  const booleanFields = ['auto_renewal', 'hidden'];

  items.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`clients[${index}] 必须是对象`);
      return;
    }

    const client: Record<string, unknown> = {};
    for (const field of stringFields) {
      const text = textField(item[field], `clients[${index}].${field}`, errors, {
        required: field === 'uuid',
        maxLength: field === 'token' || field === 'token_hash' ? 256 : 512,
      });
      if (text !== undefined) client[field] = text;
    }
    for (const field of numberFields) {
      const min = field === 'billing_cycle' || field === 'price' ? -1 : 0;
      client[field] = numberField(item[field], `clients[${index}].${field}`, errors, 0, min, Number.MAX_SAFE_INTEGER);
    }
    for (const field of booleanFields) {
      client[field] = booleanField(item[field]);
    }

    const uuid = String(client.uuid || '');
    const token = String(client.token || '');
    const tokenHash = String(client.token_hash || '');
    if (uuid) {
      if (uuids.has(uuid)) errors.push(`clients uuid 重复: ${uuid}`);
      uuids.add(uuid);
    }
    if (token) {
      if (tokens.has(token)) errors.push(`clients token 重复: ${token}`);
      tokens.add(token);
    }
    if (tokenHash) {
      if (tokenHashes.has(tokenHash)) errors.push(`clients token_hash 重复: ${tokenHash}`);
      tokenHashes.add(tokenHash);
    }

    clients.push(client as Partial<Client>);
  });

  return clients;
}

function validatePingTasks(items: unknown[], errors: string[]): PingTask[] {
  return items.flatMap((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`ping_tasks[${index}] 必须是对象`);
      return [];
    }

    const id = item.id === undefined
      ? undefined
      : integerField(item.id, `ping_tasks[${index}].id`, errors, 0, 1, Number.MAX_SAFE_INTEGER);
    const candidate = {
      name: textField(item.name, `ping_tasks[${index}].name`, errors, { maxLength: 128 }) || '',
      clients: stringArrayField(item.clients, `ping_tasks[${index}].clients`, errors, MAX_CLIENTS),
      all_clients: booleanField(item.all_clients),
      type: textField(item.type, `ping_tasks[${index}].type`, errors, { maxLength: 16 }) || 'icmp',
      target: textField(item.target, `ping_tasks[${index}].target`, errors, { maxLength: 512 }) || '',
      interval_sec: integerField(item.interval_sec ?? item.interval, `ping_tasks[${index}].interval_sec`, errors, 60, 60, 86400),
      sort_order: integerField(item.sort_order, `ping_tasks[${index}].sort_order`, errors, index + 1, 1, Number.MAX_SAFE_INTEGER),
    };
    const validated = validatePingTaskInput(candidate);
    if (!validated.ok) {
      errors.push(...validated.errors.map(error => `ping_tasks[${index}]: ${error}`));
      return [];
    }

    return [{
      id,
      ...validated.task,
      sort_order: candidate.sort_order,
    }];
  });
}

function validateOfflineNotifications(items: unknown[], errors: string[]): OfflineNotification[] {
  return items.flatMap((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`offline_notifications[${index}] 必须是对象`);
      return [];
    }

    return [{
      client: textField(item.client, `offline_notifications[${index}].client`, errors, { required: true, maxLength: 128 }) || '',
      enable: booleanField(item.enable),
      grace_period: integerField(item.grace_period, `offline_notifications[${index}].grace_period`, errors, 180, 30, 86400),
      last_notified: optionalTimeField(item.last_notified, `offline_notifications[${index}].last_notified`, errors),
    }];
  });
}

function validateExpiryNotifications(items: unknown[], errors: string[]): ExpiryNotification[] {
  return items.flatMap((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`expiry_notifications[${index}] 必须是对象`);
      return [];
    }

    return [{
      client: textField(item.client, `expiry_notifications[${index}].client`, errors, { required: true, maxLength: 128 }) || '',
      enable: booleanField(item.enable),
      advance_days: integerField(item.advance_days, `expiry_notifications[${index}].advance_days`, errors, 7, 1, 365),
      last_notified: optionalTimeField(item.last_notified, `expiry_notifications[${index}].last_notified`, errors),
    }];
  });
}

function validateLoadNotifications(items: unknown[], errors: string[]): LoadNotification[] {
  const metrics = new Set<LoadNotificationMetric>(['cpu', 'ram', 'load', 'disk', 'temp']);
  return items.flatMap((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`load_notifications[${index}] 必须是对象`);
      return [];
    }

    const metric = textField(item.metric, `load_notifications[${index}].metric`, errors, { maxLength: 16 }) || 'cpu';
    const normalizedMetric = metrics.has(metric as LoadNotificationMetric)
      ? metric as LoadNotificationMetric
      : 'cpu';
    if (normalizedMetric !== metric) {
      errors.push(`load_notifications[${index}].metric 无效`);
    }

    return [{
      id: item.id === undefined ? undefined : integerField(item.id, `load_notifications[${index}].id`, errors, 0, 1, Number.MAX_SAFE_INTEGER),
      name: textField(item.name, `load_notifications[${index}].name`, errors, { maxLength: 128 }) || '',
      clients: stringArrayField(item.clients, `load_notifications[${index}].clients`, errors, MAX_CLIENTS),
      metric: normalizedMetric,
      threshold: numberField(item.threshold, `load_notifications[${index}].threshold`, errors, 80, 0, 100000),
      ratio: numberField(item.ratio, `load_notifications[${index}].ratio`, errors, 0.8, 0, 1),
      interval_min: integerField(item.interval_min, `load_notifications[${index}].interval_min`, errors, 15, 1, 10080),
      last_notified: optionalTimeField(item.last_notified, `load_notifications[${index}].last_notified`, errors),
    }];
  });
}

export function validateBackup(input: unknown): BackupValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['备份内容必须是对象'] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const schema = textField(input.schema, 'schema', errors, { maxLength: 64 });
  const version = textField(input.version, 'version', errors, { required: true, maxLength: 32 }) || '';
  const scope = textField(input.scope, 'scope', errors, { maxLength: 32 });
  const timestamp = textField(input.timestamp, 'timestamp', errors, { maxLength: 64 });

  if (schema && schema !== BACKUP_SCHEMA_ID) {
    errors.push(`schema 不支持: ${schema}`);
  }
  if (scope && scope !== BACKUP_SCOPE) {
    errors.push(`scope 不支持: ${scope}`);
  }
  if (!schema) {
    warnings.push('旧备份缺少 schema 字段，已按 version 兼容校验');
  }
  if (!scope) {
    warnings.push('旧备份缺少 scope 字段，已按配置备份处理');
  }
  if (version && !version.startsWith('1.') && !version.startsWith('2.')) {
    errors.push(`version 不支持: ${version}`);
  }

  const backup: BackupData = {
    schema: schema || BACKUP_SCHEMA_ID,
    version,
    scope: BACKUP_SCOPE,
    timestamp,
    excluded: [...BACKUP_EXCLUDED_MODULES],
    sensitive: true,
    warning: BACKUP_SENSITIVE_WARNING,
  };
  let hasModule = false;

  if (input.settings !== undefined) {
    const normalized = sanitizeSettingsForStorage(input.settings);
    if (!normalized.ok) {
      errors.push(...normalized.errors.map((error) => `settings.${error}`));
    }
    if (normalized.ignoredKeys.length > 0) {
      warnings.push(`已忽略移除的设置: ${normalized.ignoredKeys.join(', ')}`);
    }
    backup.settings = normalized.settings;
    hasModule = true;
  }

  const clients = requireArray(input, 'clients', MAX_CLIENTS, errors);
  if (clients) {
    backup.clients = validateClients(clients, errors);
    hasModule = true;
  }

  const pingTasks = requireArray(input, 'ping_tasks', MAX_PING_TASKS, errors);
  if (pingTasks) {
    backup.ping_tasks = validatePingTasks(pingTasks, errors);
    hasModule = true;
  }

  const offlineNotifications = requireArray(input, 'offline_notifications', MAX_NOTIFICATIONS, errors);
  if (offlineNotifications) {
    backup.offline_notifications = validateOfflineNotifications(offlineNotifications, errors);
    hasModule = true;
  }

  const expiryNotifications = requireArray(input, 'expiry_notifications', MAX_NOTIFICATIONS, errors);
  if (expiryNotifications) {
    backup.expiry_notifications = validateExpiryNotifications(expiryNotifications, errors);
    hasModule = true;
  }

  const loadNotifications = requireArray(input, 'load_notifications', MAX_NOTIFICATIONS, errors);
  if (loadNotifications) {
    backup.load_notifications = validateLoadNotifications(loadNotifications, errors);
    hasModule = true;
  }

  if (!hasModule) {
    errors.push('备份至少需要包含一个可恢复模块');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, backup, warnings };
}

export async function encryptBackup(backup: BackupData, password: string): Promise<BackupEncryptResult> {
  const passwordError = encryptBackupPasswordError(password);
  if (passwordError) return { ok: false, error: passwordError };

  const salt = new Uint8Array(BACKUP_SALT_BYTES);
  const iv = new Uint8Array(BACKUP_IV_BYTES);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);
  const key = await deriveBackupKey(password, salt, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(backup));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: BACKUP_ENCRYPTION_ALGORITHM, iv },
    key,
    plaintext,
  ));

  return {
    ok: true,
    encryptedBackup: {
      schema: ENCRYPTED_BACKUP_SCHEMA_ID,
      version: BACKUP_VERSION,
      scope: BACKUP_SCOPE,
      timestamp: backup.timestamp || new Date().toISOString(),
      encrypted: true,
      excluded: [...BACKUP_EXCLUDED_MODULES],
      encryption: {
        algorithm: BACKUP_ENCRYPTION_ALGORITHM,
        kdf: BACKUP_KDF,
        iterations: BACKUP_KDF_ITERATIONS,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
      },
      ciphertext: bytesToBase64(ciphertext),
    },
  };
}

export async function decryptBackup(input: unknown, password: string): Promise<BackupDecryptResult> {
  const passwordError = backupPasswordError(password, MIN_BACKUP_DECRYPT_PASSWORD_BYTES);
  if (passwordError) return { ok: false, error: passwordError };
  if (!isPlainObject(input)) return { ok: false, error: '加密备份内容必须是对象' };
  if (input.schema !== ENCRYPTED_BACKUP_SCHEMA_ID || input.encrypted !== true) {
    return { ok: false, error: '不是受支持的加密备份文件' };
  }
  const encryption = input.encryption;
  if (!isPlainObject(encryption)) return { ok: false, error: '加密参数缺失' };
  if (encryption.algorithm !== BACKUP_ENCRYPTION_ALGORITHM || encryption.kdf !== BACKUP_KDF) {
    return { ok: false, error: '加密算法不受支持' };
  }
  const iterations = Number(encryption.iterations);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    return { ok: false, error: 'KDF 参数无效' };
  }
  const salt = typeof encryption.salt === 'string' ? base64ToBytes(encryption.salt) : null;
  const iv = typeof encryption.iv === 'string' ? base64ToBytes(encryption.iv) : null;
  const ciphertext = typeof input.ciphertext === 'string' ? base64ToBytes(input.ciphertext) : null;
  if (!salt || salt.length !== BACKUP_SALT_BYTES || !iv || iv.length !== BACKUP_IV_BYTES || !ciphertext || ciphertext.length === 0) {
    return { ok: false, error: '加密备份编码无效' };
  }

  try {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt,
        iterations,
      },
      keyMaterial,
      {
        name: BACKUP_ENCRYPTION_ALGORITHM,
        length: 256,
      },
      false,
      ['decrypt'],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: BACKUP_ENCRYPTION_ALGORITHM, iv },
      key,
      ciphertext,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    const validated = validateBackup(parsed);
    if (!validated.ok) return { ok: false, error: `解密成功但备份校验失败: ${validated.errors.join('；')}` };
    return { ok: true, backup: validated.backup };
  } catch {
    return { ok: false, error: '备份密码错误或文件已损坏' };
  }
}

export function summarizeBackup(backup: BackupData): BackupSummary {
  return {
    settings: backup.settings !== undefined,
    settings_count: backup.settings ? Object.keys(backup.settings).length : 0,
    clients: backup.clients?.length || 0,
    ping_tasks: backup.ping_tasks?.length || 0,
    offline_notifications: backup.offline_notifications?.length || 0,
    expiry_notifications: backup.expiry_notifications?.length || 0,
    load_notifications: backup.load_notifications?.length || 0,
    website_monitors: backup.website_monitors?.length || 0,
  };
}
