import type { GPUInfo, MonitorRecord } from '../db/queries';

type JsonObject = Record<string, unknown>;

export type MonitorReportPayload = JsonObject & {
  cpu: number;
  gpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  load: number | null;
  temp: number | null;
  disk: number | null;
  disk_total: number | null;
  disk_source?: 'directory';
  disk_sampled_at?: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number | null;
  version: string;
  gpus: GPUInfo[];
};

export const MAX_GPU_RECORDS_PER_REPORT = 16;
const MAX_GPU_DEVICE_NAME_LENGTH = 128;
const MAX_PERCENT = 100;
const MAX_TEMPERATURE_C = 150;
const MAX_DEVICE_INDEX = 1024;
const MAX_COUNT_VALUE = 10_000_000;
const MAX_LOAD_VALUE = 10_000;
const MAX_UPTIME_SECONDS = 315_576_000;
const MAX_COUNTER_VALUE = 1_000_000_000_000_000;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = numberFrom(value);
    if (parsed !== undefined) return parsed;
  }
  return 0;
}

function boundedNumber(min: number, max: number, ...values: unknown[]): number {
  const value = firstNumber(...values);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function boundedInteger(min: number, max: number, ...values: unknown[]): number {
  return Math.trunc(boundedNumber(min, max, ...values));
}

// 负载允许「不可用」：探针在 lxcfs 未虚拟化 loadavg 的容器里读到的是
// 宿主机负载，与其报一个错值或 0（会被读成空闲），不如显式报 null。
// 只有探针**显式送了 null** 才算不可用；字段缺失仍按 0 处理，老探针行为不变。
function boundedNullableNumber(min: number, max: number, primary: unknown, ...fallbacks: unknown[]): number | null {
  if (primary === null) return null;
  return boundedNumber(min, max, primary, ...fallbacks);
}

function measuredTemperature(value: unknown): number | null {
  const temperature = numberFrom(value);
  return temperature !== undefined && temperature >= -100 && temperature <= MAX_TEMPERATURE_C
    ? temperature
    : null;
}

function boundedString(value: unknown, maxLength: number): string {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeGpuList(rawGpu: JsonObject, rawGpus: unknown): GPUInfo[] {
  const explicit = Array.isArray(rawGpus) ? rawGpus : undefined;
  const detailed = Array.isArray(rawGpu.detailed_info) ? rawGpu.detailed_info : undefined;
  const list = (explicit || detailed || []).slice(0, MAX_GPU_RECORDS_PER_REPORT);

  return list.map((item, index) => {
    const gpu = asObject(item);
    const memTotal = boundedNumber(0, MAX_COUNTER_VALUE, gpu.mem_total, gpu.memory_total);
    const memUsedMax = memTotal > 0 ? memTotal : MAX_COUNTER_VALUE;
    return {
      device_index: boundedInteger(0, MAX_DEVICE_INDEX, gpu.device_index, gpu.index, index),
      device_name: boundedString(gpu.device_name || gpu.name || '', MAX_GPU_DEVICE_NAME_LENGTH),
      mem_total: memTotal,
      mem_used: boundedNumber(0, memUsedMax, gpu.mem_used, gpu.memory_used),
      utilization: boundedNumber(0, MAX_PERCENT, gpu.utilization),
      temperature: boundedNumber(0, MAX_TEMPERATURE_C, gpu.temperature),
    };
  });
}

export function normalizeMonitorReport(input: unknown): MonitorReportPayload {
  const inputObject = asObject(input);
  const raw = inputObject.type === 'report' && inputObject.data ? inputObject.data : input;
  const report = asObject(raw);
  const cpu = asObject(report.cpu);
  const ram = asObject(report.ram);
  const swap = asObject(report.swap);
  const load = asObject(report.load);
  const disk = asObject(report.disk);
  const network = asObject(report.network);
  const connections = asObject(report.connections);
  const gpuData = asObject(report.gpu);
  const gpus = normalizeGpuList(gpuData, report.gpus);

  const normalized: MonitorReportPayload = {
    ...report,
    cpu: boundedNumber(0, MAX_PERCENT, report.cpu, cpu.usage),
    gpu: boundedNumber(0, MAX_PERCENT, report.gpu, gpuData.average_usage),
    ram: boundedNumber(0, MAX_COUNTER_VALUE, report.ram, ram.used),
    ram_total: boundedNumber(0, MAX_COUNTER_VALUE, report.ram_total, ram.total),
    swap: boundedNumber(0, MAX_COUNTER_VALUE, report.swap, swap.used),
    swap_total: boundedNumber(0, MAX_COUNTER_VALUE, report.swap_total, swap.total),
    load: boundedNullableNumber(0, MAX_LOAD_VALUE, report.load, load.load1),
    temp: measuredTemperature(report.temp),
    disk: boundedNullableNumber(0, MAX_COUNTER_VALUE, report.disk, disk.used),
    disk_total: boundedNullableNumber(0, MAX_COUNTER_VALUE, report.disk_total, disk.total),
    net_in: boundedNumber(0, MAX_COUNTER_VALUE, report.net_in, network.down),
    net_out: boundedNumber(0, MAX_COUNTER_VALUE, report.net_out, network.up),
    net_total_up: boundedNumber(0, MAX_COUNTER_VALUE, report.net_total_up, network.totalUp),
    net_total_down: boundedNumber(0, MAX_COUNTER_VALUE, report.net_total_down, network.totalDown),
    process_count: boundedInteger(0, MAX_COUNT_VALUE, report.process_count, report.process),
    connections: boundedInteger(0, MAX_COUNT_VALUE, report.connections, connections.tcp),
    connections_udp: boundedInteger(0, MAX_COUNT_VALUE, report.connections_udp, connections.udp),
    uptime: boundedNullableNumber(0, MAX_UPTIME_SECONDS, report.uptime),
    version: boundedString(report.version, 64),
    gpus,
  };
  // Cached measurements carry their own sampling clock, independent of the
  // Agent report/Worker receipt clocks. An invalid pair must not look native.
  delete normalized.disk_source;
  delete normalized.disk_sampled_at;
  if (report.disk_source !== undefined || report.disk_sampled_at !== undefined) {
    const sampledAt = report.disk_sampled_at;
    const measuredUsed = numberFrom(report.disk) ?? numberFrom(disk.used);
    if (report.disk_source === 'directory' && normalized.disk !== null && measuredUsed !== undefined
        && measuredUsed >= 0 && measuredUsed <= MAX_COUNTER_VALUE && typeof sampledAt === 'number'
        && Number.isSafeInteger(sampledAt) && sampledAt > 0 && sampledAt <= 8_640_000_000_000_000) {
      normalized.disk_source = 'directory';
      normalized.disk_sampled_at = sampledAt;
    } else {
      normalized.disk = null;
    }
  }
  return normalized;
}

export function toMonitorRecord(client: string, time: string, input: unknown): MonitorRecord {
  const report = normalizeMonitorReport(input);
  // Keep measured bytes independently. The numeric schema uses a zero total
  // to leave the percentage unavailable when either input is unknown.
  const diskAvailable = report.disk !== null && report.disk_total !== null;

  return {
    client,
    time,
    cpu: report.cpu || 0,
    gpu: report.gpu || 0,
    ram: report.ram || 0,
    ram_total: report.ram_total || 0,
    swap: report.swap || 0,
    swap_total: report.swap_total || 0,
    load: report.load ?? null,
    temp: report.temp,
    disk: report.disk ?? 0,
    disk_total: diskAvailable ? report.disk_total || 0 : 0,
    net_in: report.net_in || 0,
    net_out: report.net_out || 0,
    net_total_up: report.net_total_up || 0,
    net_total_down: report.net_total_down || 0,
    process_count: report.process_count || 0,
    connections: report.connections || 0,
    connections_udp: report.connections_udp || 0,
    uptime: report.uptime || 0,
  };
}
