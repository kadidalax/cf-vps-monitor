import { formatBytes } from './format';

export const BYTES_PER_GB = 1024 * 1024 * 1024;
export const BYTES_PER_TB = BYTES_PER_GB * 1024;

export const TRAFFIC_LIMIT_TYPES = [
  { label: '总计', value: 'sum' },
  { label: '最大值', value: 'max' },
  { label: '最小值', value: 'min' },
  { label: '仅上传', value: 'up' },
  { label: '仅下载', value: 'down' },
] as const;

export const TRAFFIC_LIMIT_UNITS = [
  { label: 'GB', value: 'GB', factor: BYTES_PER_GB },
  { label: 'TB', value: 'TB', factor: BYTES_PER_TB },
] as const;

export const BANDWIDTH_UNITS = ['Mbps', 'Gbps'] as const;

export type TrafficLimitMode = 'quota' | 'unlimited' | 'bandwidth';
export type TrafficLimitUnit = typeof TRAFFIC_LIMIT_UNITS[number]['value'];
export type BandwidthUnit = typeof BANDWIDTH_UNITS[number];

export interface TrafficLimitFormValue {
  mode: TrafficLimitMode;
  value: string;
  unit: TrafficLimitUnit;
  type: string;
  bandwidthValue: string;
  bandwidthUnit: BandwidthUnit;
}

const BANDWIDTH_PREFIX = 'bandwidth:';

export function parseTrafficLimitType(type?: string | null): string {
  const value = String(type || '').trim();
  return TRAFFIC_LIMIT_TYPES.some((option) => option.value === value) ? value : 'sum';
}

export function parseBandwidthLimit(type?: string | null): { value: string; unit: BandwidthUnit } | null {
  const raw = String(type || '').trim();
  if (!raw.startsWith(BANDWIDTH_PREFIX)) return null;
  const bandwidth = raw.slice(BANDWIDTH_PREFIX.length).trim();
  const match = bandwidth.match(/^(\d+(?:\.\d+)?)(Mbps|Gbps)$/i);
  if (!match) return { value: '', unit: 'Mbps' };
  return {
    value: match[1],
    unit: match[2].toLowerCase() === 'gbps' ? 'Gbps' : 'Mbps',
  };
}

export function createTrafficLimitFormValue(limit?: number, type?: string | null): TrafficLimitFormValue {
  const bandwidth = parseBandwidthLimit(type);
  if (bandwidth) {
    return {
      mode: 'bandwidth',
      value: '',
      unit: 'TB',
      type: 'sum',
      bandwidthValue: bandwidth.value,
      bandwidthUnit: bandwidth.unit,
    };
  }

  const bytes = Number(limit || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return {
      mode: 'unlimited',
      value: '',
      unit: 'TB',
      type: parseTrafficLimitType(type),
      bandwidthValue: '',
      bandwidthUnit: 'Mbps',
    };
  }

  const unit: TrafficLimitUnit = bytes >= BYTES_PER_TB ? 'TB' : 'GB';
  const factor = unit === 'TB' ? BYTES_PER_TB : BYTES_PER_GB;
  const value = Number((bytes / factor).toFixed(2));

  return {
    mode: 'quota',
    value: String(value),
    unit,
    type: parseTrafficLimitType(type),
    bandwidthValue: '',
    bandwidthUnit: 'Mbps',
  };
}

export function serializeTrafficLimitFormValue(value: TrafficLimitFormValue): { traffic_limit: number; traffic_limit_type: string } {
  if (value.mode === 'bandwidth') {
    const bandwidth = Number(value.bandwidthValue || 0);
    return {
      traffic_limit: 0,
      traffic_limit_type: bandwidth > 0 ? `${BANDWIDTH_PREFIX}${bandwidth}${value.bandwidthUnit}` : 'unlimited',
    };
  }

  if (value.mode === 'unlimited') {
    return {
      traffic_limit: 0,
      traffic_limit_type: 'unlimited',
    };
  }

  const numericValue = Number(value.value || 0);
  const unit = TRAFFIC_LIMIT_UNITS.find((option) => option.value === value.unit) || TRAFFIC_LIMIT_UNITS[0];
  return {
    traffic_limit: Number.isFinite(numericValue) && numericValue > 0
      ? Math.round(numericValue * unit.factor)
      : 0,
    traffic_limit_type: parseTrafficLimitType(value.type),
  };
}

export function formatTrafficLimitType(type?: string | null): string {
  const value = parseTrafficLimitType(type);
  return TRAFFIC_LIMIT_TYPES.find((option) => option.value === value)?.label || '总计';
}

export function formatTrafficLimitLabel(limit?: number, type?: string | null): string {
  const bandwidth = parseBandwidthLimit(type);
  if (bandwidth?.value) return `${bandwidth.value} ${bandwidth.unit} 无限流量`;
  if (String(type || '').trim() === 'unlimited') return '无限流量';
  if (!limit || limit <= 0) return '';
  return `${formatTrafficLimitType(type)} (${formatBytes(limit)})`;
}
