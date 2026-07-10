export interface Client {
  uuid: string;
  token: string;
  token_hash: string;
  token_last_used_at: string | null;
  token_last_used_ip: string;
  token_rotated_at: string | null;
  name: string;
  cpu_name: string;
  virtualization: string;
  arch: string;
  cpu_cores: number;
  os: string;
  kernel_version: string;
  gpu_name: string;
  ipv4: string;
  ipv6: string;
  region: string;
  remark: string;
  public_remark: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  version: string;
  price: number;
  billing_cycle: number;
  auto_renewal: boolean;
  currency: string;
  expired_at: string;
  group: string;
  tags: string;
  hidden: boolean;
  traffic_limit: number;
  traffic_limit_type: string;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export type PublicClientRow = Omit<Client, 'token' | 'token_hash' | 'token_last_used_at' | 'token_last_used_ip' | 'token_rotated_at' | 'remark'> & {
  ipv4: string;
  ipv6: string;
};

export type ScheduledClientRow = Pick<Client, 'uuid' | 'name' | 'created_at' | 'expired_at'>;
export type ClientTokenMeta = Pick<Client, 'uuid' | 'token' | 'token_hash' | 'name'>;
export type ClientIdentity = Pick<Client, 'uuid' | 'token' | 'token_last_used_ip' | 'token_rotated_at' | 'created_at' | 'name' | 'hidden'>;

export interface ClientVisibility {
  uuid: string;
  hidden: boolean;
}

export interface ClientCapacityCounts {
  clients: number;
  gpu_clients: number;
}

export interface MonitorRecord {
  id?: number;
  client: string;
  time: string;
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
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  next_cursor?: string;
}

export type LoadNotificationMetric = 'cpu' | 'ram' | 'load' | 'disk' | 'temp';

export interface LoadMetricWindowStats {
  samples: number;
  exceeded: number;
  avg_value: number;
}

export type DeleteOldRowsOptions = {
  maxBatches?: number;
};

export type HistoryDeleteCounts = {
  records: number;
  gpu_records: number;
  gpu_snapshots: number;
  ping_records: number;
  ping_snapshots: number;
};

export type ClearAllRecordsResult = {
  deleted: HistoryDeleteCounts;
  remaining: HistoryDeleteCounts;
  has_more: boolean;
};

export type DeleteClientsResult = {
  removed: number;
  deleted_records: HistoryDeleteCounts;
};

export interface GPUInfo {
  device_index: number;
  device_name: string;
  mem_total: number;
  mem_used: number;
  utilization: number;
  temperature: number;
}

export type GPUHistoryRecord = GPUInfo & {
  id?: number;
  client: string;
  time: string;
};

export interface User {
  uuid: string;
  username: string;
  passwd: string;
  session_version: number;
  password_changed_at: string | null;
  totp_secret_enc: string | null;
  totp_enabled_at: string | null;
  totp_last_used_step: number;
  recovery_code_hashes: string[];
  created_at: string;
  updated_at: string;
}

export interface LoginRateLimit {
  bucket: string;
  failures: number;
  first_failed_at: string;
  last_failed_at: string;
  locked_until: string | null;
}

export interface AuditLogEntry {
  id?: number;
  time: string;
  user: string;
  action: string;
  detail: string;
  level: string;
}

export interface AuditLogsPage {
  logs: AuditLogEntry[];
  total: number;
  has_more: boolean;
}

export interface Theme {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  preview_path: string;
  style_path: string;
  manifest_json: string;
  config_json: string;
  custom_css: string;
  created_at: string;
  updated_at: string;
}

export interface ThemeAsset {
  theme_short: string;
  path: string;
  content_type: string;
  content_base64: string;
  size_bytes: number;
  created_at: string;
}

export type ThemeUpsertInput = Omit<Theme, 'created_at' | 'updated_at'>;
export type ThemeAssetUpsertInput = Omit<ThemeAsset, 'theme_short' | 'created_at'>;

export interface PingTask {
  id?: number;
  name: string;
  clients: string[];
  all_clients: boolean;
  type: string;
  target: string;
  interval_sec: number;
  sort_order?: number;
}

export type PingTaskEstimateRow = Pick<PingTask, 'id' | 'name' | 'clients' | 'all_clients' | 'interval_sec'>;

export interface PingHistoryRecord {
  id?: number;
  client: string;
  task_id: number;
  time: string;
  value: number;
}

export interface PingSnapshotInput {
  taskId: number;
  value: number;
}

export interface PingTaskHistoryRequest {
  taskId: number;
  limit?: number;
  intervalSec?: number;
}

export type WebsiteMonitorStatus = 'pending' | 'up' | 'down' | 'paused';
export type WebsiteMonitorMethod = 'GET' | 'HEAD' | 'TCP';
export type WebsiteAgentProbeMode = 'off' | 'selected' | 'country_auto';
export type WebsiteCheckSourceType = 'worker' | 'agent';

export interface WebsiteMonitor {
  id: number;
  name: string;
  url: string;
  method: WebsiteMonitorMethod;
  expected_status_min: number;
  expected_status_max: number;
  interval_sec: number;
  timeout_sec: number;
  grace_period_sec: number;
  enabled: boolean;
  hidden: boolean;
  agent_probe_mode: WebsiteAgentProbeMode;
  agent_probe_clients: string[];
  agent_probe_limit: number;
  agent_probe_status_enabled: boolean;
  sort_order: number;
  status: WebsiteMonitorStatus;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_status_code: number | null;
  last_raw_status_code: number | null;
  last_latency_ms: number | null;
  last_effective_reason: string | null;
  last_error: string | null;
  down_since: string | null;
  last_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WebsiteMonitorInput = Omit<
  WebsiteMonitor,
  | 'id'
  | 'sort_order'
  | 'status'
  | 'last_checked_at'
  | 'last_success_at'
  | 'last_failure_at'
  | 'last_status_code'
  | 'last_raw_status_code'
  | 'last_latency_ms'
  | 'last_effective_reason'
  | 'last_error'
  | 'down_since'
  | 'last_notified_at'
  | 'created_at'
  | 'updated_at'
>;

export interface WebsiteCheck {
  id: number;
  monitor_id: number;
  checked_at: string;
  ok: boolean;
  effective_status: Extract<WebsiteMonitorStatus, 'up' | 'down'>;
  effective_reason: string | null;
  status_code: number | null;
  raw_status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  source_type: WebsiteCheckSourceType;
  source_client: string | null;
}

export type WebsiteCheckInput =
  Omit<WebsiteCheck, 'id' | 'source_type' | 'source_client'> &
  Partial<Pick<WebsiteCheck, 'source_type' | 'source_client'>>;

export interface PublicWebsiteMonitor {
  id: number;
  name: string;
  url: string;
  interval_sec: number;
  status: WebsiteMonitorStatus;
  last_checked_at: string | null;
  last_status_code: number | null;
  last_raw_status_code: number | null;
  last_latency_ms: number | null;
  last_effective_reason: string | null;
  checks: Array<Pick<WebsiteCheck, 'checked_at' | 'ok' | 'effective_status' | 'effective_reason' | 'status_code' | 'raw_status_code' | 'latency_ms' | 'source_type' | 'source_client'>>;
}

export interface OfflineNotificationUpdate {
  client: string;
  enable: boolean;
  grace_period: number;
}

export interface OfflineNotification extends OfflineNotificationUpdate {
  last_notified: string | null;
}

export interface ExpiryNotificationUpdate {
  client: string;
  enable: boolean;
  advance_days: number;
}

export interface ExpiryNotification extends ExpiryNotificationUpdate {
  last_notified: string | null;
}

export interface LoadNotification {
  id?: number;
  name: string;
  clients: string[];
  metric: LoadNotificationMetric;
  threshold: number;
  ratio: number;
  interval_min: number;
  last_notified: string | null;
}

export interface LoadNotificationInput {
  id?: unknown;
  name?: unknown;
  clients?: unknown;
  metric?: unknown;
  threshold?: unknown;
  ratio?: unknown;
  interval_min?: unknown;
  last_notified?: unknown;
  [key: string]: unknown;
}

export interface ClientReferenceCleanupResult {
  ping_tasks_updated: number;
  load_notifications_updated: number;
  load_notifications_deleted: number;
  expiry_notifications_deleted: number;
}

export interface OrphanClientDataCleanupResult extends ClientReferenceCleanupResult {
  offline_notifications_deleted: number;
  records_deleted: number;
  gpu_records_deleted: number;
  gpu_snapshots_deleted: number;
  ping_records_deleted: number;
  ping_snapshots_deleted: number;
}

export interface TableRowCounts {
  records: number;
  gpu_records: number;
  gpu_snapshots: number;
  ping_records: number;
  ping_snapshots: number;
  audit_logs: number;
}

export type HistoryTableRowCounts = Omit<TableRowCounts, 'audit_logs'>;

export interface BoundedTableRowCounts {
  counts: TableRowCounts;
  capped: Partial<Record<keyof TableRowCounts, boolean>>;
  limit: number;
}
