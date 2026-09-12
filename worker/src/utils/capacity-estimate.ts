import { buildQuotaReference, QUOTA_COMPARISON_MONTH_DAYS } from './quota.ts';

export type ResourceKey = 'worker_requests' | 'durable_object_requests' | 'durable_object_rows_written'
  | 'durable_object_rows_read' | 'durable_object_duration_gb_seconds' | 'supabase_storage_bytes' | 'supabase_egress_bytes';

export interface ResourceEstimate {
  key: ResourceKey;
  period: 'day' | 'month' | 'retained';
  websocket: number | null;
  http: number | null;
  estimate: 'lower_bound' | 'estimate' | 'unknown';
  free_included: number;
  paid_included: number;
  paid_period: 'month' | 'retained';
  paid_usage_websocket: number | null;
  paid_usage_http: number | null;
  within_free_websocket: boolean | null;
  within_free_http: boolean | null;
  notes: string[];
}

export interface CapacityResourceInput {
  clientCount: number;
  activeSecondsPerDay: number;
  sampleIntervalSec: number;
  idleIntervalSec: number;
  monitorRecordsPerDay: number;
  pingTaskStateWritesPerDay: number;
  pingTaskPullsPerDay: number;
  pingResultReportsPerDay: number;
  basicInfoReportsPerDay: number;
  connectionsPerDay: number;
  cronInvocationsPerDay: number;
  estimatedSupabaseStorageBytes: number;
}

export function buildResourceEstimates(input: CapacityResourceInput) {
  const quota = buildQuotaReference();
  const activeSeconds = Math.max(0, Math.min(86400, input.activeSecondsPerDay));
  const monitorReports = Math.ceil(input.clientCount * activeSeconds / Math.max(1, input.sampleIntervalSec))
    + Math.ceil(input.clientCount * (86400 - activeSeconds) / Math.max(1, input.idleIntervalSec));
  const messages = monitorReports + input.pingTaskPullsPerDay + input.pingResultReportsPerDay + input.basicInfoReportsPerDay;
  const workerWs = input.cronInvocationsPerDay + input.connectionsPerDay;
  const workerHttp = input.cronInvocationsPerDay + messages;
  const doWs = input.connectionsPerDay + Math.ceil(messages / 20);
  const doHttp = messages;
  const wsWrites = input.monitorRecordsPerDay + input.pingTaskStateWritesPerDay + monitorReports;
  const httpWrites = wsWrites;
  const resources: ResourceEstimate[] = [];
  const add = (key: ResourceKey, period: ResourceEstimate['period'], websocket: number | null, http: number | null,
    estimate: ResourceEstimate['estimate'], free: number, paid: number, notes: string[]) => {
    const paidPeriod = period === 'retained' ? 'retained' : 'month';
    const monthlyFactor = period === 'day' ? QUOTA_COMPARISON_MONTH_DAYS : 1;
    resources.push({
      key, period, websocket, http, estimate, free_included: free, paid_included: paid, paid_period: paidPeriod,
      paid_usage_websocket: websocket === null ? null : websocket * monthlyFactor,
      paid_usage_http: http === null ? null : http * monthlyFactor,
      within_free_websocket: websocket === null ? null : websocket <= free,
      within_free_http: http === null ? null : http <= free,
      notes,
    });
  };
  add('worker_requests', 'day', workerWs, workerHttp, 'estimate', quota.workers.requests.daily_free, quota.workers.requests.monthly_included,
    ['Agent与Cron场景估算；未包含访客、管理请求、重连突发。付费包含量按30天对比，不是每日硬上限。']);
  add('durable_object_requests', 'day', doWs, doHttp, 'lower_bound', quota.durable_objects.requests.daily_free, quota.durable_objects.requests.monthly_included,
    ['包含monitor报告、Ping拉取/结果及basic_info；20:1仅用于入站WebSocket消息的计费请求，不适用于行写入。未含闹钟、访客与其他内部调用。']);
  add('durable_object_rows_written', 'day', wsWrites, httpWrites, 'lower_bound', quota.durable_objects.rows_written.daily_free, quota.durable_objects.rows_written.monthly_included,
    ['HTTP和WebSocket每次monitor上报均持久化1行最后快照，关闭历史仍然写入；批量上报只为最后一条写1行。历史启用时另计落库标记和每节点每到期Ping任务状态。消息20:1折算不适用于行写入，其他元数据、闹钟和节点删除仍有额外开销。']);
  add('durable_object_rows_read', 'day', null, null, 'unknown', quota.durable_objects.rows_read.daily_free, quota.durable_objects.rows_read.monthly_included,
    ['冷启动恢复list/get、设置和状态读取依运行情况而变；需从Cloudflare实际用量核对。']);
  add('durable_object_duration_gb_seconds', 'day', null, null, 'unknown', quota.durable_objects.duration_gb_seconds.daily_free, quota.durable_objects.duration_gb_seconds.monthly_included,
    ['时长取决于处理耗时与休眠情况；不能按消息20:1或节点数推断。']);
  add('supabase_storage_bytes', 'retained', input.estimatedSupabaseStorageBytes, input.estimatedSupabaseStorageBytes, 'estimate',
    quota.database.storage_bytes.free_project_reference, quota.database.storage_bytes.pro_project_reference,
    ['按配置保留期估算监控/GPU/Ping历史；网站、审计、设置和数据库其他对象需额外空间。实际项目配额以Supabase为准。']);
  add('supabase_egress_bytes', 'month', null, null, 'unknown', 5 * 1024 ** 3, 250 * 1024 ** 3,
    ['查询次数、图片、响应体和压缩会影响出站量；必须核对Supabase实际egress，未知不能当0。']);
  return {
    resource_estimates: resources,
    monitor_reports_per_day: monitorReports,
    agent_websocket_messages_per_day: messages,
    estimated_worker_requests_per_day: workerWs,
    estimated_worker_requests_http_per_day: workerHttp,
    estimated_durable_object_requests_per_day: doWs,
    estimated_durable_object_requests_http_per_day: doHttp,
    do_write_breakdown: {
      history_markers: input.monitorRecordsPerDay, ping_task_state: input.pingTaskStateWritesPerDay,
      websocket_live_state: monitorReports, http_live_state: monitorReports,
    },
    free_tier_assessment: resources.some(row => row.within_free_websocket === false || row.within_free_http === false)
      ? 'exceeds' as const : 'unverified' as const,
  };
}
