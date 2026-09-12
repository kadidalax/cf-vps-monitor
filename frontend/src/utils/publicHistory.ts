export interface PublicMonitorRecord {
  time: string;
  cpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number | null;
  disk_total: number | null;
  // null = 探针报告本机负载不可取信（容器内 /proc/loadavg 透传宿主机），不是 0。
  load: number | null;
  temp: number | null;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number | null;
}

export interface PublicGpuRecord {
  time: string;
  utilization: number;
  mem_total: number;
  mem_used: number;
  temperature: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function listItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  return Array.isArray(record?.data) ? record.data : [];
}

function timeField(record: Record<string, unknown>): string | null {
  const value = record.time;
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  if (!(key in record) || record[key] === undefined) return 0;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function allNumbers<K extends string>(values: Record<K, number | null>): values is Record<K, number> {
  return Object.values(values).every((value): value is number => value !== null);
}

function optionalMetric(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// 负载允许显式为 null（不可用）。这里必须与 numberField 分开：
// numberField 把 null 当作「字段非法」，会让 allNumbers 判否而**整条记录被丢弃**——
// 后果是那台节点的历史图表整段消失，而不是负载一项缺失。
// 返回 undefined 表示字段真的非法，整条丢弃。
function loadField(record: Record<string, unknown>): number | null | undefined {
  if (!('load' in record) || record.load === undefined) return 0;
  if (record.load === null) return null;
  return typeof record.load === 'number' && Number.isFinite(record.load) ? record.load : undefined;
}

export function normalizePublicMonitorRecord(payload: unknown): PublicMonitorRecord | null {
  const record = asRecord(payload);
  if (!record) return null;
  const time = timeField(record);
  if (!time) return null;
  const load = loadField(record);
  if (load === undefined) return null;
  // 温度未知不能补成 0，也不能丢弃同一条记录中的 CPU 等有效指标。
  const temp = typeof record.temp === 'number' && Number.isFinite(record.temp) ? record.temp : null;
  const values = {
    cpu: numberField(record, 'cpu'),
    ram: numberField(record, 'ram'),
    ram_total: numberField(record, 'ram_total'),
    swap: numberField(record, 'swap'),
    swap_total: numberField(record, 'swap_total'),
    net_in: numberField(record, 'net_in'),
    net_out: numberField(record, 'net_out'),
    net_total_up: numberField(record, 'net_total_up'),
    net_total_down: numberField(record, 'net_total_down'),
    process_count: numberField(record, 'process_count'),
    connections: numberField(record, 'connections'),
    connections_udp: numberField(record, 'connections_udp'),
  };
  if (!allNumbers(values)) return null;

  return {
    time,
    cpu: values.cpu,
    ram: values.ram,
    ram_total: values.ram_total,
    swap: values.swap,
    swap_total: values.swap_total,
    disk: optionalMetric(record, 'disk'),
    disk_total: optionalMetric(record, 'disk_total'),
    load,
    temp,
    net_in: values.net_in,
    net_out: values.net_out,
    net_total_up: values.net_total_up,
    net_total_down: values.net_total_down,
    process_count: values.process_count,
    connections: values.connections,
    connections_udp: values.connections_udp,
    uptime: optionalMetric(record, 'uptime'),
  };
}

export function normalizePublicMonitorRecords(payload: unknown): PublicMonitorRecord[] {
  return listItems(payload).flatMap((item) => {
    const record = normalizePublicMonitorRecord(item);
    return record ? [record] : [];
  });
}

export function normalizePublicGpuRecord(payload: unknown): PublicGpuRecord | null {
  const record = asRecord(payload);
  if (!record) return null;
  const time = timeField(record);
  if (!time) return null;
  const values = {
    utilization: numberField(record, 'utilization'),
    mem_total: numberField(record, 'mem_total'),
    mem_used: numberField(record, 'mem_used'),
    temperature: numberField(record, 'temperature'),
  };
  if (!allNumbers(values)) return null;

  return {
    time,
    utilization: values.utilization,
    mem_total: values.mem_total,
    mem_used: values.mem_used,
    temperature: values.temperature,
  };
}

export function normalizePublicGpuRecords(payload: unknown): PublicGpuRecord[] {
  return listItems(payload).flatMap((item) => {
    const record = normalizePublicGpuRecord(item);
    return record ? [record] : [];
  });
}

export async function collectCursorHistory<T extends { time: string }>(
  fetchPage: (cursor: string) => Promise<unknown>,
  options: {
    cursor: string;
    start: string;
    end?: string;
    normalize: (payload: unknown) => T[];
    signal?: AbortSignal;
    maxPages?: number;
  },
): Promise<T[]> {
  const start = Date.parse(options.start);
  const end = Date.parse(options.end || options.cursor);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('历史时间范围无效');
  const records = new Map<number, T>();
  const result = () => [...records.entries()].sort(([a], [b]) => a - b).map(([, record]) => record);
  let cursor = options.cursor;
  const maxPages = Math.min(32, Math.max(1, options.maxPages ?? 32));
  for (let page = 0; page < maxPages; page += 1) {
    options.signal?.throwIfAborted();
    const payload = await fetchPage(cursor);
    options.signal?.throwIfAborted();
    const envelope = asRecord(payload);
    if (!Array.isArray(payload) && !Array.isArray(envelope?.data)) throw new Error('历史记录响应格式无效');
    for (const record of options.normalize(payload)) {
      const at = Date.parse(record.time);
      if (at >= start && at <= end) records.set(at, record);
    }
    if (envelope?.has_more !== true) return result();
    const next = typeof envelope.next_cursor === 'string' ? envelope.next_cursor : '';
    const nextAt = Date.parse(next);
    if (!Number.isFinite(nextAt) || nextAt >= Date.parse(cursor)) throw new Error('历史分页游标无效');
    if (nextAt <= start) return result();
    cursor = next;
  }
  throw new Error('历史记录过多，请选择更短的时间范围');
}
