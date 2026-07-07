import assert from 'node:assert/strict';

const {
  callSupabaseRpc,
  SupabaseApiError,
} = await import('./client.ts');

async function captureHeaders(env) {
  let headers = null;
  await callSupabaseRpc(env, 'cfm_users_count', {}, async (_url, init) => {
    headers = new Headers(init.headers);
    return Response.json(0);
  });
  return headers;
}

const secretKey = 'sb_secret_test_secret_key';
const legacyKey = 'legacy-service-role-jwt';

let headers = await captureHeaders({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: secretKey,
});
assert.equal(headers.get('apikey'), secretKey);
assert.equal(headers.has('Authorization'), false);

headers = await captureHeaders({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: secretKey,
});
assert.equal(headers.get('apikey'), secretKey);
assert.equal(headers.has('Authorization'), false);

headers = await captureHeaders({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: secretKey,
  SUPABASE_SERVICE_ROLE_KEY: legacyKey,
});
assert.equal(headers.get('apikey'), secretKey);
assert.equal(headers.has('Authorization'), false);

headers = await captureHeaders({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: legacyKey,
});
assert.equal(headers.get('apikey'), legacyKey);
assert.equal(headers.get('Authorization'), `Bearer ${legacyKey}`);

await assert.rejects(
  () => callSupabaseRpc(
    {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: secretKey,
    },
    'cfm_users_count',
    {},
    async () => new Response(`bad key ${secretKey}`, { status: 401 }),
  ),
  (error) => {
    assert.equal(error instanceof SupabaseApiError, true);
    assert.equal(error.message.includes(secretKey), false);
    assert.equal(error.message.includes('[REDACTED]'), true);
    return true;
  },
);
