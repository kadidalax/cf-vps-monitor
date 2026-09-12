/**
 * 记录落库节流的判定逻辑。
 *
 * 背景：Agent 空闲态默认每 120 秒上报一次，而 DO 的落库节流间隔默认也是 120 秒。
 * 两者相等时，若用零容差的 `now - lastPersist < interval` 判断，只要相邻两次上报的
 * 到达间隔因网络抖动比 120 秒少哪怕几毫秒，这一轮就会被判为「未到时间」而跳过落库；
 * 下一次落库要再等 120 秒，于是数据库里的 last_time 拉开到 240 秒间隔，
 * 越过默认离线宽限期，产生系统性的误报离线告警。
 *
 * 解法：给判定加一个提前量（tolerance），让略早于整间隔到达的上报也能落库。
 * 提前量取间隔的 5%、上限 5 秒：
 * - 默认 120 秒间隔 → 5 秒，足以吸收网络抖动与 DO 调度延迟；
 * - 按比例缩放，保证 3 秒最小间隔（活跃态）下不会退化成每次上报都写库，
 *   写入量最多上浮约 5%，不冲击 DO 行写入配额。
 */

export const RECORD_PERSIST_TOLERANCE_MAX_MS = 5_000;
export const RECORD_PERSIST_TOLERANCE_RATIO = 0.05;

/** 计算某个落库间隔对应的提前量（毫秒）。 */
export function recordPersistToleranceMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.min(
    RECORD_PERSIST_TOLERANCE_MAX_MS,
    Math.floor(intervalMs * RECORD_PERSIST_TOLERANCE_RATIO),
  );
}

/**
 * 计算实际判定阈值：距上次落库达到该毫秒数即可落库。
 * 即 `interval - tolerance`，且不小于 0。
 */
export function recordPersistThresholdMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  return Math.max(0, intervalMs - recordPersistToleranceMs(intervalMs));
}

/** 距上次落库 elapsedMs 毫秒后，是否应当落库。 */
export function isRecordPersistDue(elapsedMs: number, intervalMs: number): boolean {
  if (!Number.isFinite(elapsedMs)) return false;
  return elapsedMs >= recordPersistThresholdMs(intervalMs);
}
