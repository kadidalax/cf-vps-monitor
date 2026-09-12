export const SUPABASE_FREE_DATABASE_STORAGE_REFERENCE_BYTES = 500 * 1024 * 1024;
export const SUPABASE_PRO_DATABASE_STORAGE_REFERENCE_BYTES = 8 * 1024 * 1024 * 1024;
export const WORKERS_FREE_DAILY_REQUESTS = 100_000;
export const WORKERS_PAID_MONTHLY_REQUESTS_INCLUDED = 10_000_000;
export const QUOTA_COMPARISON_MONTH_DAYS = 30;
export const ESTIMATED_MONITOR_RECORD_BYTES = 420;
export const ESTIMATED_PING_RECORD_BYTES = 160;
export const ESTIMATED_PING_SNAPSHOT_BYTES = 220;
export const ESTIMATED_GPU_SNAPSHOT_BYTES = 420;

export function buildQuotaReference() {
  return {
    database: {
      storage_bytes: {
        free_project_reference: SUPABASE_FREE_DATABASE_STORAGE_REFERENCE_BYTES,
        pro_project_reference: SUPABASE_PRO_DATABASE_STORAGE_REFERENCE_BYTES,
        note: 'Use the current Supabase project plan as the source of truth; these are planning references for local capacity estimates.',
      },
      estimated_row_bytes: {
        monitor_record: ESTIMATED_MONITOR_RECORD_BYTES,
        gpu_snapshot: ESTIMATED_GPU_SNAPSHOT_BYTES,
        ping_record: ESTIMATED_PING_RECORD_BYTES,
        ping_snapshot: ESTIMATED_PING_SNAPSHOT_BYTES,
      },
    },
    workers: {
      requests: {
        daily_free: WORKERS_FREE_DAILY_REQUESTS,
        monthly_included: WORKERS_PAID_MONTHLY_REQUESTS_INCLUDED,
        comparison_month_days: QUOTA_COMPARISON_MONTH_DAYS,
      },
    },
    durable_objects: {
      requests: { daily_free: 100_000, monthly_included: 1_000_000 },
      duration_gb_seconds: { daily_free: 13_000, monthly_included: 400_000 },
      rows_read: { daily_free: 5_000_000, monthly_included: 25_000_000_000 },
      rows_written: { daily_free: 100_000, monthly_included: 50_000_000 },
    },
    sources: {
      supabase_pricing: 'https://supabase.com/pricing',
      supabase_data_api: 'https://supabase.com/docs/guides/api',
      workers_limits: 'https://developers.cloudflare.com/workers/platform/limits/',
      workers_pricing: 'https://developers.cloudflare.com/workers/platform/pricing/',
      durable_objects_pricing: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
    },
  };
}
