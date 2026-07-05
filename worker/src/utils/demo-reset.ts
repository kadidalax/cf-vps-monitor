import * as db from '../db/queries';
import { isDemoResetEnabled, shouldRunDemoReset } from './demo-reset-schedule';

export const DEMO_RESET_INTERVAL_MS = 30 * 60 * 1000;

type DemoResetEnv = {
  DEMO_RESET_ENABLED?: string;
};

export async function runDemoResetIfDue(
  database: db.QueryDatabase,
  env: DemoResetEnv,
  now = Date.now(),
): Promise<boolean> {
  const enabled = isDemoResetEnabled(env.DEMO_RESET_ENABLED);
  if (!enabled) return false;

  const state = await db.getDemoResetState(database);
  if (!shouldRunDemoReset({
    enabled,
    snapshotExists: Boolean(state?.snapshot_exists),
    lastRestoredAt: state?.last_restored_at || null,
    now,
    intervalMs: DEMO_RESET_INTERVAL_MS,
  })) {
    return false;
  }

  const snapshot = await db.getDemoSnapshot(database);
  if (!snapshot) return false;

  await db.restoreBackupData(database, snapshot);
  await db.markDemoResetRestored(database, new Date(now).toISOString());
  await db.insertAuditLog(database, 'system', 'demo_reset', 'Demo snapshot restored by scheduled reset');
  return true;
}
