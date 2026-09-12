import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { validateClientUpdateInput } = await import('./client.ts');

// ── 流量重置日：节点级配置，后台改完经 agent policy 下发 ──

// 1) 后台接口必须接受并校验该字段
{
  const r = validateClientUpdateInput({ traffic_reset_day: 15 });
  assert.equal(r.ok, true);
  assert.equal(r.client.traffic_reset_day, 15);
}
for (const invalid of [0, 32, -1, 1.5]) {
  const r = validateClientUpdateInput({ traffic_reset_day: invalid });
  assert.equal(r.ok, false, `traffic_reset_day=${invalid} 必须被拒绝`);
}

// ── 2) RPC 的列清单是写死的，漏一处就「保存成功但毫无效果」 ──
// 这类坑在本项目出现过两次（hide_url 只改读 RPC、主题枚举漏登记），
// 共同表现都是：接口 200、前端状态更新、刷新后打回原形。
const rpc = readFileSync(new URL('../../../supabase/migrations/4_rpc_api.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../../supabase/migrations/1_core_schema.sql', import.meta.url), 'utf8');

assert.ok(
  /traffic_reset_day smallint not null default 1/.test(schema),
  'clients 表必须有 traffic_reset_day 列',
);
assert.ok(
  /alter table clients add column if not exists traffic_reset_day/.test(rpc),
  '存量库必须能幂等补上 traffic_reset_day 列',
);
assert.ok(
  /traffic_limit, traffic_limit_type, traffic_reset_day, sort_order/.test(rpc),
  'cfm_admin_clients 的列清单必须包含 traffic_reset_day，否则后台读不到、编辑表单回填成默认值',
);
assert.ok(
  /traffic_reset_day = case when input_patch \? 'traffic_reset_day'/.test(rpc),
  'cfm_update_client_returning 必须处理 traffic_reset_day，否则保存被静默丢弃',
);
assert.ok(
  /insert into clients \([\s\S]{0,240}traffic_limit_type, traffic_reset_day/.test(rpc),
  'cfm_create_client 必须直接写入口径与重置日（admin.ts 的建完再补一刀已删除）',
);

// 3) 默认值正规化：新建节点口径为 sum、离线宽限期为 360
assert.ok(
  /traffic_limit_type text not null default 'sum'/.test(schema),
  "traffic_limit_type 列默认值必须是 'sum'",
);
assert.ok(
  /alter table clients alter column traffic_limit_type set default 'sum';/.test(rpc),
  '存量库的口径默认值也要正规化',
);
assert.ok(
  /grace_period integer not null default 360/.test(schema),
  '离线宽限期列默认值必须是 360，与前端 DEFAULT_GRACE_PERIOD_SEC 对齐',
);

// 4) admin.ts 里「建完节点再 update 一次口径」的补丁必须已经删除
const admin = readFileSync(new URL('../routes/admin.ts', import.meta.url), 'utf8');
assert.ok(
  !/db_default_traffic_type/.test(admin),
  '建节点后补写口径的临时补丁应随迁移落地一并删除',
);

// 5) policy 里该字段必须是可选的：后台没有记录时不能下发默认 1，
//    否则会把安装时指定的 --traffic-reset-day 悄悄改掉，并连带清零当期累计。
const live = readFileSync(new URL('../do/live-data.ts', import.meta.url), 'utf8');
assert.ok(
  /traffic_reset_day\?: number;/.test(live),
  'AgentPolicyMessage 的 traffic_reset_day 必须是可选字段',
);
assert.ok(
  /traffic_reset_day: await this\.trafficResetDayFor\(clientId\)/.test(live),
  'policy 必须按 clientId 取该节点自己的重置日',
);

// ── 6) 备份还原：新增列的第三个必经之处 ──
// 读 RPC、写 RPC 都补了，还原路径漏掉的表现是「备份恢复后所有节点重置日回落到 1」，
// 而按 CHANGELOG 的说明这会连带清零每台机器的当期累计——比丢配置更糟。
// 这里锁两层：SQL 的 insert/upsert 列清单，以及 backup.ts 的字段白名单。
assert.ok(
  /hidden, traffic_limit, traffic_limit_type, traffic_reset_day, sort_order, created_at, updated_at/.test(rpc),
  'cfm_restore_backup_data 的 insert 列清单必须包含 traffic_reset_day',
);
assert.ok(
  /traffic_reset_day = excluded\.traffic_reset_day/.test(rpc),
  '还原的 on conflict do update 也必须覆盖 traffic_reset_day，否则覆盖式恢复丢配置',
);
assert.ok(
  !/coalesce\(item->>'traffic_limit_type', 'max'\)/.test(rpc),
  "还原路径的口径兜底不得停留在旧的 'max'（其余两处已是 'sum'）",
);

const backup = readFileSync(new URL('./backup.ts', import.meta.url), 'utf8');
assert.ok(
  /client\.traffic_reset_day = numberField\(/.test(backup),
  'backup.ts 的字段白名单必须收录 traffic_reset_day，否则导入时被静默丢弃',
);
assert.ok(
  /`clients\[\$\{index\}\]\.traffic_reset_day`,\s*\n\s*errors,\s*\n\s*1,\s*\n\s*1,\s*\n\s*31,/.test(backup),
  'traffic_reset_day 的缺省值与下界必须是 1——沿用 numberFields 的 0 会违反 check 约束、整个还原失败',
);

console.log('ok - 流量重置日的接口、RPC 列清单与 policy 下发');
