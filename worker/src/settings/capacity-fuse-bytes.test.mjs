import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { SETTING_SCHEMA } = await import('./schema.ts');
const { evaluateHistoryCapacity } = await import('../utils/history-capacity.ts');

// ── 容量熔断改成量字节 ──
// 原本数行数：同样行数可能对应 72MB 也可能 189MB，且完全不含索引开销，
// AUD-13: allocated物理字节保留诊断，但DELETE后不缩小；熔断必须使用
// 明确标注的有效数据字节估算，并保留行数边界与80%恢复低水位。

const entry = SETTING_SCHEMA.record_high_watermark_bytes;
assert.ok(entry, '必须存在 record_high_watermark_bytes 设置项');
assert.equal(entry.type, 'integer');
assert.equal(entry.defaultValue, '419430400', '默认 400 MiB');
assert.equal(entry.public, false, '容量熔断线不对游客公开');
assert.ok(entry.min >= 16_777_216, '下界不能低到让熔断永远处于触发态');

// 行数熔断保留为次要边界：存量用户调过这个值，静默删掉会改变他们的行为
assert.ok(SETTING_SCHEMA.record_high_watermark_rows, '行数熔断线仍应保留');

const live = readFileSync(new URL('../do/live-data.ts', import.meta.url), 'utf8');
const rpc = readFileSync(new URL('../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const schemaSql = readFileSync(new URL('../../../supabase/migrations/1_core_schema.sql', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../routes/admin.ts', import.meta.url), 'utf8');

// 1) 度量必须来自 pg_total_relation_size（含索引与 TOAST），不能是 pg_relation_size
assert.match(rpc, /create or replace function public\.cfm_history_storage_bytes\(\)/,
  '必须有按字节度量的 RPC');
assert.match(rpc, /pg_total_relation_size\('public\.records'\)/,
  "必须用 pg_total_relation_size：pg_relation_size 不含索引，正是旧口径漏算的部分");
assert.match(rpc, /grant execute on function public\.cfm_history_storage_bytes\(\) to service_role;/,
  '新 RPC 必须只授权 service_role');
assert.doesNotMatch(rpc, /grant execute on function public\.cfm_history_storage_bytes\(\) to (?:anon|authenticated);/,
  '不得把容量 RPC 暴露给匿名或登录角色');

// 2) 种子与熔断判定
assert.match(schemaSql, /\('record_high_watermark_bytes', '419430400'\)/, '设置种子必须写入默认值');
const limits = { rowLimit: 700000, byteLimit: 419430400 };
const small = { live_rows: 1, estimated_live_storage_bytes: 420, allocated_bytes: 600 * 1024 * 1024 };
assert.equal(evaluateHistoryCapacity(small, limits).blocked, false, '大allocated不能阻塞已清理的有效数据');
assert.equal(evaluateHistoryCapacity({ ...small, estimated_live_storage_bytes: limits.byteLimit }, limits).blocked, true, '字节到线熔断');
assert.equal(evaluateHistoryCapacity({ ...small, live_rows: limits.rowLimit }, limits).blocked, true, '行数到线熔断');
assert.equal(evaluateHistoryCapacity(small, { ...limits, wasBlocked: true }).blocked, false, '低于低水位恢复');

// 3) 快照复用：熔断线改了必须立刻重算，否则改了设置也要等缓存过期才生效
assert.match(live, /snapshot\.highWatermarkBytes === this\.recordHighWatermarkBytes/,
  '字节熔断线变化必须让旧快照失效');

// 4) 设置变更要能传导到 DO
assert.match(admin, /'record_high_watermark_bytes',/, '后台必须允许编辑该设置');
assert.match(live, /'record_high_watermark_bytes',/, 'DO 必须订阅该设置键');

console.log('ok - 有效数据字节/行数熔断与allocated诊断分离');
