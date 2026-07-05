export type DemoResetDecision = {
  enabled: boolean;
  snapshotExists: boolean;
  lastRestoredAt: string | null;
  now: number;
  intervalMs: number;
};

export function isDemoResetEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() || '');
}

function parseTimeMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldRunDemoReset(decision: DemoResetDecision): boolean {
  if (!decision.enabled || !decision.snapshotExists) return false;
  const last = parseTimeMs(decision.lastRestoredAt);
  return last === 0 || decision.now - last >= decision.intervalMs;
}
