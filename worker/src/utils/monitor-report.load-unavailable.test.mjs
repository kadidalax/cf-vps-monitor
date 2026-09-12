import assert from 'node:assert/strict';

const { normalizeMonitorReport, toMonitorRecord } = await import('./monitor-report.ts');

// ── 负载「不可用」的线路契约 ──
// LXC 容器上 lxcfs 若未开 lxcfs.loadavg=1，/proc/loadavg 直接透传宿主机数值：
// test2-LXC 实测 1 核容器报负载 9.29、任务总数 9500，而容器内只有 17 个进程。
// 探针据此显式上报 load: null。服务端必须把 null 一路保留到落库，
// **不能补成 0**——0 会被读成「空闲」，负载图和告警都会当成真实数据。

const unavailable = normalizeMonitorReport({ cpu: 26, load: null });
assert.equal(unavailable.load, null, '显式 null 必须保留为 null');
assert.equal(unavailable.cpu, 26, '其余指标不受影响');

const record = toMonitorRecord('node-1', '2026-08-14T00:00:00Z', { load: null });
assert.equal(record.load, null, '落库记录同样保留 null');

// 老探针不带 load 字段：按 0 处理，行为不变（不能因为本次改动把老节点变成「不可用」）
assert.equal(normalizeMonitorReport({ cpu: 1 }).load, 0, '字段缺失仍按 0');
assert.equal(toMonitorRecord('n', 't', { cpu: 1 }).load, 0, '字段缺失落库为 0');

// 正常数值路径不受影响，边界仍然收敛
assert.equal(normalizeMonitorReport({ load: 1.25 }).load, 1.25);
assert.equal(normalizeMonitorReport({ load: -5 }).load, 0, '负值仍钳到下界');
assert.equal(normalizeMonitorReport({ load: 999_999 }).load, 10_000, '超大值仍钳到上界');

// 兼容嵌套结构 { load: { load1 } }：不是 null，走原有回退
assert.equal(normalizeMonitorReport({ load: { load1: 2.5 } }).load, 2.5);

// load 为 0 是**真实的空闲**，不能被 ?? 或 || 误伤成 null
assert.equal(toMonitorRecord('n', 't', { load: 0 }).load, 0, '真实的 0 必须保留为 0');

console.log('ok - monitor-report 负载 null 语义');

// ── 数据库侧的两条约束（扫 SQL） ──
// 这两处漏改的表现都是「代码看着对、行为却不对」：列还是 not null 时写 null 直接报错；
// 告警窗口把 null 当 0 时，节点看起来「一直不超阈值」，与「没有数据」是两回事。
const { readFileSync } = await import('node:fs');
const schema = readFileSync(new URL('../../../supabase/migrations/1_core_schema.sql', import.meta.url), 'utf8');
const rpc = readFileSync(new URL('../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');

assert.ok(
  /^\s*load double precision,\s*$/m.test(schema),
  'records.load 必须建成可空列（不能再带 not null default 0）',
);
assert.ok(
  /alter table records alter column load drop not null;/.test(rpc),
  '存量库必须有幂等的 drop not null，否则老库写 null 会直接失败',
);
assert.ok(
  /input_metric <> 'load' or records\.load is not null/.test(rpc),
  '负载告警窗口必须排除 load 为 null 的采样点',
);
assert.ok(
  !/when input_metric = 'load' then coalesce\(load, 0\)/.test(rpc),
  '负载告警不得把 null 当成 0 参与统计',
);

// ── 写入路径（这一环最容易漏，漏了上面四条全绿但功能是废的）──
// 落库 RPC 若照抄其它字段的 coalesce(..., 0)，探针报的 null 会在写入时被补成 0，
// 库里永远不会出现 null：可空列白改、is not null 过滤永远筛不到、前端解析永远走不到。
assert.ok(
  !/coalesce\(\(input_record->>'load'\)::double precision, 0\),/.test(rpc),
  '落库 RPC 不得把 load 无条件 coalesce 成 0（会把「不可用」写成「空闲」）',
);
assert.ok(
  /jsonb_typeof\(input_record->'load'\) = 'null'/.test(rpc),
  '落库 RPC 必须区分「显式 null」与「字段缺失」：前者写 null，后者仍写 0',
);

// ── 读取路径：游标翻页不能把 null 键吃掉 ──
// jsonb_strip_nulls 是递归的，套在整个响应外面会连 data 数组里 load 为 null 的键
// 一起删掉，而前端把「键不存在」当作 0。公开历史续读走的正是这个 RPC。
const cursorBody = rpc.slice(rpc.indexOf('function public.cfm_records_range_cursor'));
const cursorSelect = cursorBody.slice(0, cursorBody.indexOf('$$;'));
assert.ok(
  !/jsonb_strip_nulls\(jsonb_build_object\(\s*\n\s*'data',/.test(cursorSelect),
  'records 游标 RPC 不得把 data 数组包进 jsonb_strip_nulls',
);
assert.ok(
  /\|\| jsonb_build_object\(\s*\n\s*'data',/.test(cursorSelect),
  'data 必须以未剥离 null 的形式合并进响应',
);

console.log('ok - 负载 null 的数据库约束');
