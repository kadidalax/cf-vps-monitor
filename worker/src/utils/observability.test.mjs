import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');

const OBSERVABILITY_SRC = readFileSync(join(HERE, 'observability.ts'), 'utf8');

function createScheduledHealthFixture({ failLoad = false } = {}) {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const settings = new Map([['maintenance_last_cleanup_at', new FixedDate().toISOString()]]);
  const errors = [];
  const audits = [];
  const loader = createWorkerLoader({
    globals: { Date: FixedDate, console: { ...console, error: (...args) => errors.push(args.join(' ')) } },
    db: {
      getSetting: async (_database, key) => settings.get(key) ?? null,
      getSettingsByKeys: async (_database, keys) => Object.fromEntries(
        keys.filter(key => settings.has(key)).map(key => [key, settings.get(key)]),
      ),
      setSetting: async (_database, key, value) => { settings.set(key, value); },
      listLoadNotifications: async () => {
        if (failLoad) throw new Error('synthetic load query failure');
        return [];
      },
      listOfflineNotifications: async () => [],
      listExpiryNotifications: async () => [],
      listDueWebsiteMonitors: async () => [],
      listClients: async () => [],
      tryClaimAuditThrottle: async () => true,
      insertAuditLog: async (_database, user, action, detail, level) => { audits.push({ user, action, detail, level }); },
    },
  });
  const env = {
    JWT_SECRET: 'synthetic-health-secret-at-least-32-bytes',
    SUPABASE_SECRET_KEY: 'sb_secret_synthetic_health',
    LIVE_DATA: { idFromName: name => name, get: () => ({ fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/live');
      return Response.json({ online: [], count: 0, clients: [], data: {}, timestamp: now });
    } }) },
    RATE_LIMIT: { idFromName: name => name, get: () => ({ fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/rate-limit');
      return Response.json({ allowed: true, limit: 1000, remaining: 999, reset: now / 1000 + 60, retry_after: 60 });
    } }) },
  };
  return {
    loader, settings, errors, audits,
    run: () => loader.load('worker/src/index.ts').default.scheduled({}, env, {}),
    health: () => loader.load('worker/src/routes/admin.ts').adminRoutes.fetch(
      new Request('https://health.example.test/health?refresh=1'), env,
    ),
    writtenComponents: () => [...settings.keys()]
      .filter(key => key.startsWith('health:') && !key.startsWith('health:audit:'))
      .map(key => key.slice('health:'.length)),
  };
}

// 现有测试加载器能解析无扩展名的 TS 导入；注册表和健康读写都执行正式模块。
const scheduledHealth = createScheduledHealthFixture();
const STORED_HEALTH_COMPONENTS = Array.from(
  scheduledHealth.loader.load('worker/src/utils/observability.ts').STORED_HEALTH_COMPONENTS,
);

function collectTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

// 把整份源码压成单行再匹配：这些调用大多是多行参数，
// 逐行正则会整片漏掉，看起来「零个写入点」而测试照样绿。
const SOURCE = collectTsFiles(SRC_ROOT)
  .map(file => readFileSync(file, 'utf8'))
  .join('\n')
  .replace(/\s+/g, ' ');

// 每个写入点的组件名都是第几个参数，写死在这里。
const WRITE_SITES = [
  { fn: 'bestEffortRecordHealthEvent', argIndex: 1 },
  { fn: 'recordHealthEvent', argIndex: 1 },
  { fn: 'runBackground', argIndex: 0 },
  { fn: 'recordHotPathHealthOk', argIndex: 0 },
  { fn: 'runScheduledStep', argIndex: 1 },
  { fn: 'record', argIndex: 2 },
];

function literalsAt(fn, argIndex) {
  const found = new Set();
  // 只收字面量：变量形参（component）交给 tsc 的 StoredHealthComponent 去管，
  // 这里管的是「有没有人写了注册表外的字符串」。
  const call = new RegExp(`\\b${fn}\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g');
  for (const match of SOURCE.matchAll(call)) {
    const args = splitTopLevelArgs(match[1]);
    const arg = args[argIndex];
    if (arg && /^'[a-z0-9_]+'$/.test(arg.trim())) {
      found.add(arg.trim().slice(1, -1));
    }
  }
  return found;
}

function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  let quote = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args;
}

const writtenComponents = new Set();
for (const { fn, argIndex } of WRITE_SITES) {
  for (const name of literalsAt(fn, argIndex)) writtenComponents.add(name);
}

// 有的写入点先把名字存进变量再传（live-data.ts 的
// `const component = 'agent_policy_website_probe_tasks'`），
// 调用处看不到字面量。这类赋值也算写入点。
for (const match of SOURCE.matchAll(/\bcomponent(?:: [A-Za-z]+)? = '([a-z0-9_]+)'/g)) {
  writtenComponents.add(match[1]);
}

before(async () => {
  // Cron 的组件名来自阶段元组。只统计真实执行后落下的健康键，
  // 不把未执行的配置字符串或另一份手写组件名单冒充写入点。
  await scheduledHealth.run();
  for (const component of scheduledHealth.writtenComponents()) writtenComponents.add(component);
});

test('注册表本身无重复', () => {
  assert.equal(STORED_HEALTH_COMPONENTS.length, 18, '注册表条数变了：确认是有意增删，再改这个数字');
  assert.equal(
    new Set(STORED_HEALTH_COMPONENTS).size,
    STORED_HEALTH_COMPONENTS.length,
    '重复名字会让健康页出现两条同名组件，且后写的静默盖掉前一条',
  );
});

test('扫描和运行确实找到了写入点（否则下面两条断言是空转）', () => {
  // 没有这条，任何一次重构改掉函数名都会让扫描结果变成空集，
  // 而空集天然满足「⊆ 注册表」，测试会假绿。
  assert.ok(
    writtenComponents.size >= 15,
    `只找到 ${writtenComponents.size} 个组件写入点，源码扫描或运行验证已失配`,
  );
});

test('所有写入点用到的组件名都在注册表内', () => {
  const registry = new Set(STORED_HEALTH_COMPONENTS);
  const unknown = [...writtenComponents].filter(name => !registry.has(name));
  assert.deepEqual(
    unknown,
    [],
    '这些名字写进了 settings 但 readHealthEvents 不会去读，健康页永远看不到它们',
  );
});

test('注册表里没有无人写入的孤儿组件', () => {
  const orphans = STORED_HEALTH_COMPONENTS.filter(name => !writtenComponents.has(name));
  assert.deepEqual(
    orphans,
    [],
    '注册表列了但没有任何写入点：要么名字拼错了，要么该写入点已被删除',
  );
});

test('正式定时阶段写入的健康状态完整出现在健康接口', async () => {
  assert.deepEqual(scheduledHealth.errors, [], '定时阶段必须真实执行成功，不能把测试环境错误当成正常写入');
  const written = scheduledHealth.writtenComponents().sort();
  assert.deepEqual(written, [...STORED_HEALTH_COMPONENTS].filter(name => name.startsWith('cron_')).sort());
  const response = await scheduledHealth.health();
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  for (const component of written) {
    const stored = JSON.parse(scheduledHealth.settings.get(`health:${component}`));
    assert.equal(stored.component, component);
    assert.equal(stored.status, 'ok');
    assert.equal(stored.last_success_at, '2026-09-06T12:00:00.000Z');
    assert.deepEqual(body.components[component], stored, `${component} 写入后必须能从健康接口读回`);
  }
});

test('定时阶段失败的实际写入使健康接口报告异常', async () => {
  const fixture = createScheduledHealthFixture({ failLoad: true });
  await fixture.run();
  const response = await fixture.health();
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.components.cron_load?.status, 'error');
  assert.equal(body.components.cron_load?.last_failure_at, '2026-09-06T12:00:00.000Z');
  assert.match(body.components.cron_load?.detail ?? '', /synthetic load query failure/);
  assert.equal(fixture.errors.length, 1, JSON.stringify(fixture.errors));
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0].action, 'cron_load_error');
});

// 审计节流的竞态只有数据库能真正挡住（settings 主键冲突串行化）。函数体里一旦
// 又出现 getSetting/setSetting，说明判断被搬回了 Worker 侧，锁就不在了——而这种
// 回退在单机上跑测试永远是绿的，只能从源码这一层拦。
const shouldWriteAuditLogBody = (() => {
  const body = OBSERVABILITY_SRC.match(
    /async function shouldWriteAuditLog\([\s\S]*?\n\}\r?\n/,
  );
  if (!body) throw new Error('没能从 observability.ts 里截到 shouldWriteAuditLog 函数体');
  return body[0];
})();

test('审计节流的判断与占位交给单条 RPC', () => {
  assert.match(
    shouldWriteAuditLogBody,
    /db\.tryClaimAuditThrottle\(/,
    'shouldWriteAuditLog 必须走原子 RPC',
  );
});

test('审计节流不再自己读写 settings', () => {
  assert.doesNotMatch(
    shouldWriteAuditLogBody,
    /db\.(getSetting|setSetting)\(/,
    '读一次再写一次会让并发请求同时判定可写，同一条错误落多行审计日志',
  );
});

test('审计节流的时间戳仍由 Worker 的钟生成', () => {
  assert.match(
    shouldWriteAuditLogBody,
    /nowIso\(nowMs\)/,
    '换成服务端 now() 会让同一事件的两个时间戳分属两套钟',
  );
});
