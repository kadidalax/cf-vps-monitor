import assert from 'node:assert/strict';

const {
  recordPersistToleranceMs,
  recordPersistThresholdMs,
  isRecordPersistDue,
} = await import('./record-persist.ts');

// ── 默认 120 秒间隔：提前量 5 秒（5% = 6s，被 5s 上限截断） ──
assert.equal(recordPersistToleranceMs(120_000), 5_000);
assert.equal(recordPersistThresholdMs(120_000), 115_000);

// 回归核心：上报间隔恰好等于落库间隔时，略早到达的上报必须落库。
// 修复前 119.9s 会被判为「未到时间」而跳过，导致 last_time 拉开到 240s 间隔并误报离线。
assert.equal(isRecordPersistDue(119_900, 120_000), true, '119.9s 必须落库');
assert.equal(isRecordPersistDue(115_000, 120_000), true, '恰好到阈值应落库');

// 但节流仍然有效：明显早于间隔的上报照旧跳过，写入量不因容差而失控。
assert.equal(isRecordPersistDue(114_999, 120_000), false, '114.999s 仍应跳过');
assert.equal(isRecordPersistDue(60_000, 120_000), false, '半个间隔应跳过');
assert.equal(isRecordPersistDue(0, 120_000), false, '刚落过库应跳过');

// ── 3 秒最小间隔（活跃态）：提前量按比例缩放，不退化成每次都写 ──
assert.equal(recordPersistToleranceMs(3_000), 150);
assert.equal(recordPersistThresholdMs(3_000), 2_850);
assert.equal(isRecordPersistDue(2_900, 3_000), true, '3s 间隔下略早也应落库');
assert.equal(isRecordPersistDue(1_500, 3_000), false, '3s 间隔下半程仍应跳过');

// 提前量始终远小于间隔，写入频率上浮不超过 5%
for (const interval of [3_000, 30_000, 120_000, 600_000, 3_600_000]) {
  const tolerance = recordPersistToleranceMs(interval);
  assert.ok(tolerance < interval * 0.06, `提前量不应超过间隔的 6%: ${interval}`);
  assert.ok(recordPersistThresholdMs(interval) > 0, `阈值应为正数: ${interval}`);
}

// ── 异常输入不应造成「永远落库」 ──
assert.equal(recordPersistToleranceMs(0), 0);
assert.equal(recordPersistThresholdMs(0), 0);
assert.equal(recordPersistToleranceMs(Number.NaN), 0);
assert.equal(isRecordPersistDue(Number.NaN, 120_000), false, 'NaN 不应落库');

console.log('record-persist tests passed');
