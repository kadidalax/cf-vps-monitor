import { sanitizeSetupDiagnosticDetail } from './setup-diagnostics.ts';

type ScheduledHealthEvent = {
  component: string;
  status: 'error' | 'disabled';
  updated_at: string;
  last_failure_at?: string;
  detail?: string;
};

const CRON_STARTUP_COMPONENT = 'cron_startup_probe';

let lastScheduledDatabaseStartupFailure: ScheduledHealthEvent | null = null;

export function recordScheduledDatabaseStartupFailure(error: unknown, nowMs = Date.now()): void {
  const at = new Date(nowMs).toISOString();
  lastScheduledDatabaseStartupFailure = {
    component: CRON_STARTUP_COMPONENT,
    status: 'error',
    updated_at: at,
    last_failure_at: at,
    detail: `scheduled database startup failed: ${sanitizeSetupDiagnosticDetail(error)}`,
  };
}

export function clearScheduledDatabaseStartupFailure(): void {
  lastScheduledDatabaseStartupFailure = null;
}

export function readScheduledDatabaseStartupHealth(checkedAt: string): ScheduledHealthEvent {
  return lastScheduledDatabaseStartupFailure ?? {
    component: CRON_STARTUP_COMPONENT,
    status: 'disabled',
    updated_at: checkedAt,
    detail: 'No scheduled database startup failure recorded in this Worker isolate',
  };
}
