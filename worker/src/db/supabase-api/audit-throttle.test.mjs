import assert from 'node:assert/strict';
import test from 'node:test';

const { trySupabaseClaimAuditThrottle } = await import('./client.ts');

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test_secret_key',
};

// trySupabaseClaimAuditThrottle 走 callSupabaseRpc 的默认 fetcher，只能从全局替换。
async function capture(rpcResult) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body || 'null') });
    return Response.json(rpcResult);
  };
  try {
    const claimed = await trySupabaseClaimAuditThrottle(
      ENV,
      'health:audit:last:telegram:notification_failed',
      '2026-09-03T01:02:03.004Z',
      300000,
    );
    return { claimed, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('抢占节流只发一次请求——读一次再写一次就是被修掉的那个竞态', async () => {
  const { calls } = await capture(true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

test('打到 cfm_try_claim_audit_throttle，不再碰 settings 读写 RPC', async () => {
  const { calls } = await capture(true);
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/cfm_try_claim_audit_throttle');
  assert.equal(calls[0].url.includes('cfm_public_settings'), false);
  assert.equal(calls[0].url.includes('cfm_set_settings'), false);
});

test('入参按 SQL 的形参名透传，时间戳用调用方的钟', async () => {
  const { calls } = await capture(true);
  assert.deepEqual(calls[0].body, {
    input_key: 'health:audit:last:telegram:notification_failed',
    input_now: '2026-09-03T01:02:03.004Z',
    input_throttle_ms: 300000,
  });
});

test('抢到返回 true', async () => {
  const { claimed } = await capture(true);
  assert.equal(claimed, true);
});

test('没抢到返回 false——此时必须跳过审计写入', async () => {
  const { claimed } = await capture(false);
  assert.equal(claimed, false);
});
