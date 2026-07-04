/**
 * Shared TypeScript interfaces for CF VPS Monitor frontend
 */
import { LiveRecord } from './contexts/LiveDataContext';

export interface ClientInfo {
  uuid: string;
  name: string;
  cpu_name: string;
  cpu_cores: number;
  os: string;
  arch: string;
  ipv4?: string;
  ipv6?: string;
  has_ipv4?: boolean;
  has_ipv6?: boolean;
  region: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  group: string;
  tags: string;
  hidden: boolean;
  price: number;
  billing_cycle: number;
  currency: string;
  expired_at: string;
  traffic_limit: number;
  traffic_limit_type: string;
  sort_order?: number;
  gpu_name?: string;
  version?: string;
  remark?: string;
  public_remark?: string;
  virtualization?: string;
  kernel_version?: string;
}

export interface LiveDataMap {
  online: string[];
  data: Record<string, LiveRecord>;
  clients?: Array<{ uuid: string; name?: string; lastReportTime?: number; region?: string }>;
}

export type { LiveRecord };
