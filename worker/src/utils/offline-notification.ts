/**
 * 默认离线通知宽限期（秒）。
 *
 * 取 360 秒而非更短值，是为了给「上报间隔 120 秒」留出足够余量：
 * 落库节流最坏情况下会让 last_time 拉开到约两倍上报间隔（240 秒），
 * 360 秒可覆盖该情形，避免链路正常时误报离线。
 * 落库跳写的根因已在 `utils/record-persist.ts` 修复，本值是第二道保险。
 */
export const DEFAULT_OFFLINE_GRACE_PERIOD_SEC = 360;

/**
 * 离线确认轮数：连续多少轮判定为离线才真正发告警。
 *
 * cron 每 2 分钟跑一轮，默认 3 轮 ≈ 6 分钟持续离线才告警。
 * 它防的是「单次检查不可信」——DO 刚重启、attachment 尚未恢复、
 * 查询超时等瞬时状况；只要中间有任意一轮判定在线，计数立即清零。
 *
 * 注意：这与加大宽限期不是一回事。宽限期作用在单调的「最后上报时间」上，
 * 加大它只是把阈值抬高；连续确认作用在「检查动作本身」的可靠性上。
 */
export const DEFAULT_OFFLINE_CONFIRM_ROUNDS = 3;

export type OfflineNotificationEvent =
  | {
      type: 'offline';
      offlineMs: number;
      lastSeenLabel: string;
      neverReported: boolean;
      createdAt?: string;
    }
  | {
      type: 'recovery';
      recoveredAt: string;
    };

export function evaluateOfflineNotificationEvent(args: {
  now: Date;
  clientCreatedAt: string | null | undefined;
  lastTime: string | null | undefined;
  lastNotified: string | null | undefined;
  gracePeriodSec: number;
  notifyNeverReported: boolean;
}): OfflineNotificationEvent | null {
  const graceMs = Math.max(30, Number(args.gracePeriodSec || DEFAULT_OFFLINE_GRACE_PERIOD_SEC)) * 1000;
  const nowMs = args.now.getTime();
  const neverReported = !args.lastTime;
  const referenceTime = args.lastTime || (
    args.notifyNeverReported ? args.clientCreatedAt : null
  );
  if (!referenceTime) return null;

  const referenceMs = new Date(referenceTime).getTime();
  if (Number.isNaN(referenceMs)) return null;

  const offlineMs = nowMs - referenceMs;
  if (offlineMs >= graceMs) {
    if (args.lastNotified) return null;
    return {
      type: 'offline',
      offlineMs,
      lastSeenLabel: neverReported ? '从未上报' : referenceTime,
      neverReported,
      ...(neverReported ? { createdAt: referenceTime } : {}),
    };
  }

  if (!args.lastNotified || !args.lastTime) return null;
  return { type: 'recovery', recoveredAt: args.lastTime };
}
