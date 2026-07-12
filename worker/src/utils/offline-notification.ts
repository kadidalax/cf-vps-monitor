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
  const graceMs = Math.max(30, Number(args.gracePeriodSec || 180)) * 1000;
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
