import type { HistoryStorageUsage } from '../db/types.ts';

export function evaluateHistoryCapacity(
  usage: Pick<HistoryStorageUsage, 'live_rows' | 'estimated_live_storage_bytes' | 'allocated_bytes'>,
  options: { rowLimit: number; byteLimit: number; wasBlocked?: boolean },
): { blocked: boolean; rowRatio: number; byteRatio: number; allocatedWarning: boolean } {
  const rowRatio = usage.live_rows / options.rowLimit;
  const byteRatio = usage.estimated_live_storage_bytes / options.byteLimit;
  const ratio = Math.max(rowRatio, byteRatio);
  return {
    blocked: !Number.isFinite(ratio) || (options.wasBlocked ? ratio > 0.8 : ratio >= 1),
    rowRatio,
    byteRatio,
    allocatedWarning: usage.allocated_bytes >= options.byteLimit,
  };
}
