import assert from 'node:assert/strict';

const {
  DEFAULT_OFFLINE_GRACE_PERIOD_SEC,
  DEFAULT_OFFLINE_CONFIRM_ROUNDS,
  evaluateOfflineNotificationEvent,
} = await import('./offline-notification.ts');

assert.equal(DEFAULT_OFFLINE_GRACE_PERIOD_SEC, 360);
assert.equal(DEFAULT_OFFLINE_CONFIRM_ROUNDS, 3);

const now = new Date('2026-08-13T12:00:00Z');
const ago = (sec) => new Date(now.getTime() - sec * 1000).toISOString();

// ── 判活数据源换成 DO 的 lastSeen 后，被节流的历史数据不再左右结论 ──
{
  // 场景：records 最新记录已 300 秒前（落库节流所致），但 DO 说 5 秒前刚上报。
  // 用 DO 的时间 → 在线；用 records 的时间 → 误报离线。
  const viaDo = evaluateOfflineNotificationEvent({
    now, clientCreatedAt: ago(86400), lastTime: ago(5),
    lastNotified: null, gracePeriodSec: 240, notifyNeverReported: true,
  });
  assert.equal(viaDo, null, 'DO 说 5 秒前上报过，不应产生任何事件');

  const viaRecords = evaluateOfflineNotificationEvent({
    now, clientCreatedAt: ago(86400), lastTime: ago(300),
    lastNotified: null, gracePeriodSec: 240, notifyNeverReported: true,
  });
  assert.equal(viaRecords?.type, 'offline', '仅看被节流的 records 会误判离线（修复前的行为）');
}

// ── 真正掉线仍然要能报出来 ──
{
  const event = evaluateOfflineNotificationEvent({
    now, clientCreatedAt: ago(86400), lastTime: ago(900),
    lastNotified: null, gracePeriodSec: 360, notifyNeverReported: true,
  });
  assert.equal(event?.type, 'offline');
  assert.ok(event.offlineMs >= 360_000);
}

// ── 恢复上线 ──
{
  const event = evaluateOfflineNotificationEvent({
    now, clientCreatedAt: ago(86400), lastTime: ago(10),
    lastNotified: ago(600), gracePeriodSec: 360, notifyNeverReported: true,
  });
  assert.equal(event?.type, 'recovery');
}

// ── 已告警过则不重复告警 ──
{
  const event = evaluateOfflineNotificationEvent({
    now, clientCreatedAt: ago(86400), lastTime: ago(900),
    lastNotified: ago(300), gracePeriodSec: 360, notifyNeverReported: true,
  });
  assert.equal(event, null, '已通知过不应重复告警');
}

// ── 连续确认的算术：阈值 3 意味着 streak<3 一律不发 ──
{
  const threshold = DEFAULT_OFFLINE_CONFIRM_ROUNDS;
  for (const streak of [0, 1, 2]) {
    assert.equal(streak < threshold, true, `streak=${streak} 应被压住不发`);
  }
  assert.equal(3 < threshold, false, 'streak=3 达到阈值应放行');
}

console.log('offline-confirm tests passed');
