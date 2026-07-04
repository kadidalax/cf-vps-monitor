import type { GPUInfo, MonitorRecord } from '../db/queries';

type JsonObject = Record<string, unknown>;

export type MonitorReportPayload = JsonObject & {
  cpu: number;
  gpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  load: number;
  temp: number;
  disk: number;
  disk_total: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number;
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

  return {
    ...report,
    cpu: boundedNumber(0, MAX_PERCENT, report.cpu, cpu.usage),
    gpu: boundedNumber(0, MAX_PERCENT, report.gpu, gpuData.average_usage),
    ram: boundedNumber(0, MAX_COUNTER_VALUE, report.ram, ram.used),
    ram_total: boundedNumber(0, MAX_COUNTER_VALUE, report.ram_total, ram.total),
    swap: boundedNumber(0, MAX_COUNTER_VALUE, report.swap, swap.used),
    swap_total: boundedNumber(0, MAX_COUNTER_VALUE, report.swap_total, swap.total),
    load: boundedNumber(0, MAX_LOAD_VALUE, report.load, load.load1),
    temp: boundedNumber(0, MAX_TEMPERATURE_C, report.temp, gpuData.temperature),
    disk: boundedNumber(0, MAX_COUNTER_VALUE, report.disk, disk.used),
    disk_total: boundedNumber(0, MAX_COUNTER_VALUE, report.disk_total, disk.total),
    net_in: boundedNumber(0, MAX_COUNTER_VALUE, report.net_in, network.down),
    net_out: boundedNumber(0, MAX_COUNTER_VALUE, report.net_out, network.up),
    net_total_up: boundedNumber(0, MAX_COUNTER_VALUE, report.net_total_up, network.totalUp),
    net_total_down: boundedNumber(0, MAX_COUNTER_VALUE, report.net_total_down, network.totalDown),
    process_count: boundedInteger(0, MAX_COUNT_VALUE, report.process_count, report.process),
    connections: boundedInteger(0, MAX_COUNT_VALUE, report.connections, connections.tcp),
    connections_udp: boundedInteger(0, MAX_COUNT_VALUE, report.connections_udp, connections.udp),
    uptime: boundedNumber(0, MAX_UPTIME_SECONDS, report.uptime),
    version: boundedString(report.version, 64),
    gpus,
  };
}

export function toMonitorRecord(client: string, time: string, input: unknown): MonitorRecord {
  const report = normalizeMonitorReport(input);

  return {
    client,
    time,
    cpu: report.cpu || 0,
    gpu: report.gpu || 0,
    ram: report.ram || 0,
    ram_total: report.ram_total || 0,
    swap: report.swap || 0,
    swap_total: report.swap_total || 0,
    load: report.load || 0,
    temp: report.temp || 0,
    disk: report.disk || 0,
    disk_total: report.disk_total || 0,
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
