const LOAD_NOTIFICATION_METRICS = new Set(['cpu', 'ram', 'load', 'disk', 'temp']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberField(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function integerField(value: unknown): number {
  return Math.floor(numberField(value));
}

export function validateOfflineNotificationInput(
  input: unknown,
  allowedClientIds: Set<string>,
): { ok: true; item: { client: string; enable: boolean; grace_period: number } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['离线通知必须是对象'] };
  }

  const client = stringField(input.client);
  if (!client || !allowedClientIds.has(client)) {
    errors.push('客户端不存在或不可用');
  }

  if (typeof input.enable !== 'boolean') {
    errors.push('enable 必须是布尔值');
  }

  const gracePeriod = integerField(input.grace_period ?? 180);
  if (!Number.isInteger(gracePeriod) || gracePeriod < 30 || gracePeriod > 86400) {
    errors.push('grace_period 必须是 30 到 86400 秒之间的整数');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    item: {
      client,
      enable: Boolean(input.enable),
      grace_period: gracePeriod,
    },
  };
}

export function validateExpiryNotificationInput(
  input: unknown,
  allowedClientIds: Set<string>,
): { ok: true; item: { client: string; enable: boolean; advance_days: number } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['到期通知必须是对象'] };
  }

  const client = stringField(input.client);
  if (!client || !allowedClientIds.has(client)) {
    errors.push('客户端不存在或不可用');
  }

  if (typeof input.enable !== 'boolean') {
    errors.push('enable 必须是布尔值');
  }

  const advanceDays = integerField(input.advance_days ?? 7);
  if (!Number.isInteger(advanceDays) || advanceDays < 1 || advanceDays > 365) {
    errors.push('advance_days 必须是 1 到 365 天之间的整数');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    item: {
      client,
      enable: Boolean(input.enable),
      advance_days: advanceDays,
    },
  };
}

export function validateLoadNotificationInput(
  input: unknown,
  allowedClientIds: Set<string>,
  options: { requireId?: boolean } = {},
): {
  ok: true;
  item: {
    id?: number;
    name: string;
    clients: string[];
    metric: string;
    threshold: number;
    ratio: number;
    interval_min: number;
  };
} | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['负载通知必须是对象'] };
  }

  const id = integerField(input.id);
  if (options.requireId && (!Number.isInteger(id) || id <= 0)) {
    errors.push('通知规则 ID 无效');
  }

  const name = stringField(input.name).slice(0, 128);
  if (!name) {
    errors.push('规则名称不能为空');
  }

  const rawClients = Array.isArray(input.clients) ? input.clients : [];
  const clients = rawClients
    .filter((client): client is string => typeof client === 'string')
    .map(client => client.trim())
    .filter(Boolean);
  if (clients.length > 200) {
    errors.push('客户端数量不能超过 200 个');
  }
  if (clients.some(client => !allowedClientIds.has(client))) {
    errors.push('客户端列表包含不存在的节点');
  }

  const metric = stringField(input.metric || 'cpu');
  if (!LOAD_NOTIFICATION_METRICS.has(metric)) {
    errors.push('metric 必须是 cpu、ram、load、disk 或 temp');
  }

  const threshold = numberField(input.threshold ?? 80);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100000) {
    errors.push('threshold 必须是 0 到 100000 之间的数字');
  }

  const ratio = numberField(input.ratio ?? 0.8);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    errors.push('ratio 必须是 0 到 1 之间的数字');
  }

  const intervalMin = integerField(input.interval_min ?? 15);
  if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 10080) {
    errors.push('interval_min 必须是 1 到 10080 分钟之间的整数');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    item: {
      ...(options.requireId ? { id } : {}),
      name,
      clients,
      metric,
      threshold,
      ratio,
      interval_min: intervalMin,
    },
  };
}
