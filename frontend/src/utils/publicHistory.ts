export interface PublicMonitorRecord {
  time: string;
  cpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number;
  disk_total: number;
  load: number;
  temp: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number;
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

export function normalizePublicMonitorRecord(payload: unknown): PublicMonitorRecord | null {
  const record = asRecord(payload);
  if (!record) return null;
  const time = timeField(record);
  if (!time) return null;
  const values = {
    cpu: numberField(record, 'cpu'),
    ram: numberField(record, 'ram'),
    ram_total: numberField(record, 'ram_total'),
    swap: numberField(record, 'swap'),
    swap_total: numberField(record, 'swap_total'),
    disk: numberField(record, 'disk'),
    disk_total: numberField(record, 'disk_total'),
    load: numberField(record, 'load'),
    temp: numberField(record, 'temp'),
    net_in: numberField(record, 'net_in'),
    net_out: numberField(record, 'net_out'),
    net_total_up: numberField(record, 'net_total_up'),
    net_total_down: numberField(record, 'net_total_down'),
    process_count: numberField(record, 'process_count'),
    connections: numberField(record, 'connections'),
    connections_udp: numberField(record, 'connections_udp'),
    uptime: numberField(record, 'uptime'),
  };
  if (!allNumbers(values)) return null;

  return {
    time,
    cpu: values.cpu,
    ram: values.ram,
    ram_total: values.ram_total,
    swap: values.swap,
    swap_total: values.swap_total,
    disk: values.disk,
    disk_total: values.disk_total,
    load: values.load,
    temp: values.temp,
    net_in: values.net_in,
    net_out: values.net_out,
    net_total_up: values.net_total_up,
    net_total_down: values.net_total_down,
    process_count: values.process_count,
    connections: values.connections,
    connections_udp: values.connections_udp,
    uptime: values.uptime,
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
