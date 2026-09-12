// 历史表真实占用不得被 refresh_counts 闸门挡住。
//
// 背景：字节是容量熔断的主判据，行数只是次要边界。后台的「历史容量熔断」进度条要显示
// 服务端实测的 pg_total_relation_size，否则管理员设了 400 MiB 上限却看不到离跳闸多远。
//
// 踩过的坑：字节查询最初被塞进 getCapacityRowCounts 返回的快照里，而那份快照只在
// options.forceCounts 为真时才取（即请求带 ?refresh_counts=true）。前端首屏调的是不带
// 参数的那条路，于是进度条恒为 `— / 400 MiB`，只有点「刷新实际行数」才有值——
// 而那个按钮的文案根本没提容量。线上实测：首屏 history_total_bytes = null，
// 带 refresh_counts=true 时 = 8232960。
//
// 成本上也不该被挡：pg_total_relation_size 读的是元数据，而 count(*) 是全表扫描，
// 后者才是那道闸门存在的理由。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const admin = readFileSync(join(here, '..', 'routes', 'admin.ts'), 'utf8');

/** 截取某个顶层函数的源码：从声明处到下一个顶层 function/export 声明为止。 */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `没找到 ${declaration}，本锁的定位方式已失效，需要跟着改`);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?function |\nadminRoutes\./);
  return rest.slice(0, next < 0 ? undefined : next);
}

const rowCounts = functionBody(admin, 'async function getCapacityRowCounts(');
const estimate = functionBody(admin, 'export async function buildCapacityEstimate(');

assert.ok(
  !/getHistoryStorageBytes/.test(rowCounts),
  'getCapacityRowCounts 里不得再取字节数——那份快照被 refresh_counts 挡着，' +
  '跟着它走会让后台首屏的容量进度条恒为空',
);

assert.ok(
  /getHistoryStorageBytes/.test(estimate),
  'buildCapacityEstimate 必须自己取字节数，否则响应里 history_total_bytes 恒为 null',
);

// 取值不能挂在 forceCounts / rowCounts 上。
assert.ok(
  !/history_(byte_sizes|total_bytes):\s*rowCounts\??\./.test(estimate),
  'history_byte_sizes / history_total_bytes 不得再从 rowCounts 上取值',
);

// 单个 RPC 失败只降级这一个读数，不能让整个容量估算 500。
assert.ok(
  /getHistoryStorageBytes\(database\)\.catch\(/.test(estimate),
  '字节查询必须自带 catch 降级：它现在位于首屏必经路径上，抛出会让整个 /admin/capacity 挂掉',
);

// 前端兜底文案：这条分支现在只在 RPC 真失败时出现，不能再写成「稍后刷新」——
// 用户点刷新按钮也不会让它变好，那是行数的按钮。
const page = readFileSync(join(here, '..', '..', '..', 'frontend', 'src', 'pages', 'admin', 'SettingsGeneral.tsx'), 'utf8');
assert.ok(
  /hasHistoryBytes/.test(page),
  '前端仍需区分「有真实占用」与「读不到」两种展示',
);
assert.ok(
  !/暂时读不到真实占用，稍后刷新/.test(page),
  '容量进度条的兜底文案不得再暗示「刷新一下就有」——首屏已经会取值，走到兜底就是真失败',
);

console.log('ok - 历史表真实占用不受 refresh_counts 闸门约束');
