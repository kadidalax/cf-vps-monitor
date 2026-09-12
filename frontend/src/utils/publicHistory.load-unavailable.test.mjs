import assert from 'node:assert/strict';

const { normalizePublicMonitorRecord } = await import('./publicHistory.ts');

const base = {
  time: '2026-08-14T00:00:00Z',
  cpu: 10, ram: 1, ram_total: 2, swap: 0, swap_total: 0,
  disk: 1, disk_total: 2, temp: 0,
  net_in: 0, net_out: 0, net_total_up: 0, net_total_down: 0,
  process_count: 1, connections: 1, connections_udp: 0, uptime: 100,
};

// ── 回归锁：负载不可用（null）不得让整条记录被丢弃 ──
// 解析器用 allNumbers() 做整条校验，而 numberField 把 null 视为「字段非法」。
// 若不给 load 开口子，容器节点的每一条记录都会被判为非法，
// 表现是**那台节点的历史图表整段消失**，而不是负载一项缺失——比原来的错值更难排查。
const unavailable = normalizePublicMonitorRecord({ ...base, load: null });
assert.notEqual(unavailable, null, 'load 为 null 时整条记录必须保留');
assert.equal(unavailable.load, null, 'load 保持 null，不得补成 0');
assert.equal(unavailable.cpu, 10, '其余字段照常解析');

// 正常数值与缺字段的老数据行为不变
assert.equal(normalizePublicMonitorRecord({ ...base, load: 1.5 }).load, 1.5);
assert.equal(normalizePublicMonitorRecord(base).load, 0, '缺字段仍按 0');

// 真正非法的值仍要丢弃整条，别把校验放没了
assert.equal(normalizePublicMonitorRecord({ ...base, load: 'high' }), null, '字符串负载应丢弃整条');
assert.equal(normalizePublicMonitorRecord({ ...base, cpu: null }), null, '其他字段为 null 仍丢弃整条');

console.log('ok - publicHistory 负载 null 解析');
