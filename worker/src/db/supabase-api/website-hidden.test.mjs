import assert from 'node:assert/strict';

const {
  getSupabasePublicWebsiteMonitorById,
  getSupabasePublicWebsites,
} = await import('./client.ts');

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

async function captureBody(fn) {
  let body = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json([]);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return body;
}

assert.deepEqual(
  await captureBody(() => getSupabasePublicWebsites(env, 24, 120, true)),
  { period_hours: 24, check_limit: 120, input_include_hidden: true },
);

assert.deepEqual(
  await captureBody(() => getSupabasePublicWebsiteMonitorById(env, 7, 120, true)),
  { input_id: 7, input_check_limit: 120, input_include_hidden: true },
);
