import assert from 'node:assert/strict';

const { summarizeSelectionValue } = await import('./batchPrefill.ts');

// ── 全部相同：预填该值并视为一致 ──
assert.deepEqual(summarizeSelectionValue([360, 360, 360], 360), { value: 360, consistent: true });
assert.deepEqual(summarizeSelectionValue([120, 120], 360), { value: 120, consistent: true });
assert.deepEqual(summarizeSelectionValue([600], 360), { value: 600, consistent: true });

// ── 不一致：取众数，并标记为不一致以便提示 ──
assert.deepEqual(summarizeSelectionValue([120, 300, 300], 360), { value: 300, consistent: false });
assert.deepEqual(
  summarizeSelectionValue([600, 600, 600, 120, 300], 360),
  { value: 600, consistent: false },
);

// 并列时取较小值，保证同一份选择每次结果一致
assert.deepEqual(summarizeSelectionValue([300, 600], 360), { value: 300, consistent: false });
assert.deepEqual(summarizeSelectionValue([600, 300], 360), { value: 300, consistent: false });
assert.deepEqual(summarizeSelectionValue([900, 120, 900, 120], 360), { value: 120, consistent: false });

// ── 空选择回落到默认值 ──
assert.deepEqual(summarizeSelectionValue([], 360), { value: 360, consistent: true });
assert.deepEqual(summarizeSelectionValue([], 7), { value: 7, consistent: true });

// ── 非法值不参与统计，不应污染预填 ──
assert.deepEqual(summarizeSelectionValue([Number.NaN, 300, 300], 360), { value: 300, consistent: true });
assert.deepEqual(summarizeSelectionValue([Number.NaN], 360), { value: 360, consistent: true });
assert.deepEqual(
  summarizeSelectionValue([Number.POSITIVE_INFINITY, 120, 300], 360),
  { value: 120, consistent: false },
);

// ── 回归：不得再返回与选中项无关的固定值 ──
{
  const summary = summarizeSelectionValue([120, 120, 120], 360);
  assert.notEqual(summary.value, 360, '选中项一致时不应回落到默认值');
}

console.log('batchPrefill tests passed');
