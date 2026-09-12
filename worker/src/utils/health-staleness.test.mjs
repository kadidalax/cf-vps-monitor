import assert from 'node:assert/strict';
import test from 'node:test';

import { HEALTH_STALE_AFTER_MS, healthComponentsOk, isHealthEventStale, markStaleEvents } from './health-staleness.ts';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();

test('超窗的 error 判为陈旧', () => {
  assert.equal(isHealthEventStale({ status: 'error', updated_at: ago(HEALTH_STALE_AFTER_MS + 1000) }, NOW), true);
});

test('线上那条 07-24 的旧 error 会被判为陈旧', () => {
  // 这是本项要解的实际现象：一条 6 周前的 error 把端点永久钉在 503。
  assert.equal(isHealthEventStale({ status: 'error', updated_at: '2026-07-24T03:00:00.000Z' }, NOW), true);
});

test('窗内的 error 仍然算新鲜', () => {
  assert.equal(isHealthEventStale({ status: 'error', updated_at: ago(HEALTH_STALE_AFTER_MS - 1000) }, NOW), false);
});

test('恰好等于窗口边界不算陈旧', () => {
  assert.equal(isHealthEventStale({ status: 'error', updated_at: ago(HEALTH_STALE_AFTER_MS) }, NOW), false);
});

test('非 error 状态一律不标陈旧，多久都一样', () => {
  for (const status of ['ok', 'warning', 'disabled']) {
    assert.equal(
      isHealthEventStale({ status, updated_at: ago(HEALTH_STALE_AFTER_MS * 100) }, NOW),
      false,
      `${status} 不该被标 stale`,
    );
  }
});

test('时间戳坏掉或缺失时不降级，宁可继续报错', () => {
  assert.equal(isHealthEventStale({ status: 'error', updated_at: '' }, NOW), false);
  assert.equal(isHealthEventStale({ status: 'error' }, NOW), false);
  assert.equal(isHealthEventStale({ status: 'error', updated_at: 'not-a-date' }, NOW), false);
});

test('未来时间戳不算陈旧（时钟偏差不该把真实故障吞掉）', () => {
  assert.equal(isHealthEventStale({ status: 'error', updated_at: ago(-60_000) }, NOW), false);
});

test('窗口是 6 小时', () => {
  assert.equal(HEALTH_STALE_AFTER_MS, 6 * 60 * 60 * 1000);
});

test('markStaleEvents 只加 stale 字段，不动 status 和 detail', () => {
  const stale = { component: 'cron_load', status: 'error', updated_at: '2026-07-24T03:00:00.000Z', detail: 'boom' };
  const marked = markStaleEvents({ cron_load: stale }, NOW);
  assert.equal(marked.cron_load.stale, true);
  assert.equal(marked.cron_load.status, 'error', '陈旧不等于没发生过，status 必须原样保留');
  assert.equal(marked.cron_load.detail, 'boom');
  assert.equal(stale.stale, undefined, '不该就地改传进来的对象');
});

test('markStaleEvents 不给新鲜事件加 stale，也容得下 null', () => {
  const marked = markStaleEvents(
    { fresh: { status: 'error', updated_at: ago(1000) }, missing: null },
    NOW,
  );
  assert.equal(marked.fresh.stale, undefined);
  assert.equal(marked.missing, null);
});

test('陈旧 error 不再拉红端点，新鲜 error 仍然拉红', () => {
  // 这就是 503 被永久钉死的解法本身。
  assert.equal(healthComponentsOk({ a: { status: 'error', stale: true } }), true);
  assert.equal(healthComponentsOk({ a: { status: 'error' } }), false);
  assert.equal(healthComponentsOk({ a: { status: 'error', stale: true }, b: { status: 'error' } }), false);
});

test('warning / disabled / ok / 缺失组件都不拉红端点，行为不变', () => {
  assert.equal(
    healthComponentsOk({
      a: { status: 'ok' },
      b: { status: 'warning' },
      c: { status: 'disabled' },
      d: null,
    }),
    true,
  );
});

test('现算探针的 error 照常拉红——它们从不带 stale', () => {
  // buildHealthCheck 里探针是在 markStaleEvents 之后才写进 components 的，
  // 因此永远不会带上 stale=true，这条断言锁的是那个后果。
  assert.equal(healthComponentsOk({ secret_probe: { status: 'error' } }), false);
});
