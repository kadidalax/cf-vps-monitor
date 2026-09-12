import { Miniflare, Log, LogLevel } from 'miniflare';
import { build } from 'esbuild';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../../scripts/test-support/postgres.mjs';

const root = new URL('../../', import.meta.url);
export const runtimeSecrets = {
  JWT_SECRET: 'synthetic-runtime-jwt-secret-at-least-32-bytes',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic_runtime_only',
  SUPABASE_URL: 'https://synthetic-supabase.invalid',
};

function pgArray(values) {
  return `{${values.map(value => value === null ? 'NULL' : `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

export async function createRuntimeFixture({ persistDurableObjects = false, externalResponse, triggerScheduled = false, rpcHook } = {}) {
  const database = await createTestDatabase();
  let mf;
  try {
    const functions = (await database.query(`
      select p.proname, p.proargnames, oidvectortypes(p.proargtypes) as argument_types
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'cfm_%'
    `)).rows;
    const compiled = await build({
      entryPoints: [fileURLToPath(new URL('worker/src/index.ts', root))],
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
      external: ['cloudflare:*', 'node:*'], logLevel: 'silent',
    });
    const toml = await readFile(new URL('worker/wrangler.toml', root), 'utf8');
    const date = /compatibility_date\s*=\s*"([^"]+)"/.exec(toml)?.[1];
    const rpcCalls = [];
    const outboundCalls = [];
    let initialCreateBarrier = null;
    let persistPath;
    if (persistDurableObjects) {
      const base = fileURLToPath(new URL('worker/.tmp/audit-runtime/', root));
      await mkdir(base, { recursive: true });
      persistPath = await mkdtemp(`${base}state-`);
    }
    const options = {
      modules: true, script: compiled.outputFiles[0].text,
      compatibilityDate: date, compatibilityFlags: ['nodejs_compat'],
      log: new Log(LogLevel.ERROR), port: 0,
      unsafeTriggerHandlers: triggerScheduled,
      bindings: runtimeSecrets,
      durableObjects: {
        LIVE_DATA: { className: 'LiveDataDO', useSQLite: true },
        RATE_LIMIT: { className: 'RateLimitDO', useSQLite: true },
      },
      ...(persistPath ? { durableObjectsPersist: persistPath } : {}),
      serviceBindings: { ASSETS: () => new Response('<!doctype html><title>Local fixture</title>', { headers: { 'Content-Type': 'text/html' } }) },
      outboundService: async request => {
        const url = new URL(request.url);
        outboundCalls.push(url.href);
        if (externalResponse && url.hostname.endsWith('.audit.example.com')) return externalResponse(request);
        if (url.origin !== runtimeSecrets.SUPABASE_URL || !url.pathname.startsWith('/rest/v1/rpc/')) {
          throw new Error('External network is disabled in runtime integration tests');
        }
        if (request.headers.get('apikey') !== runtimeSecrets.SUPABASE_SECRET_KEY) return Response.json({ error: 'invalid synthetic API key' }, { status: 403 });
        const name = url.pathname.split('/').at(-1);
        const args = await request.json();
        const entries = Object.entries(args);
        const definition = functions.find(item => item.proname === name && entries.every(([key]) => item.proargnames?.includes(key)));
        if (!definition || !/^cfm_[a-z0-9_]+$/.test(name)) return Response.json({ code: 'PGRST202', message: 'Unknown synthetic RPC' }, { status: 404 });
        rpcCalls.push(name);
        const beforeResponse = await rpcHook?.({ name, args, phase: 'before' });
        if (beforeResponse) return beforeResponse;
        const types = definition.argument_types ? definition.argument_types.split(', ') : [];
        const values = entries.map(([key, value]) => {
          const type = types[definition.proargnames.indexOf(key)];
          if (Array.isArray(value) && type?.endsWith('[]')) return pgArray(value);
          return value && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        try {
          const result = await database.transaction(async transaction => {
            await transaction.exec('set local role service_role');
            const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ');
            return (await transaction.query(`select public.${name}(${parameters}) as result`, values)).rows[0].result;
          });
          if (name === 'cfm_users_count' && result === 0 && initialCreateBarrier) {
            const barrier = initialCreateBarrier;
            barrier.count += 1;
            if (barrier.count === 2) { initialCreateBarrier = null; barrier.resolve(); }
            await barrier.promise;
          }
          const afterResponse = await rpcHook?.({ name, args, phase: 'after', result });
          return afterResponse || Response.json(result ?? null);
        } catch (error) {
          return Response.json({ code: error.code || 'FIXTURE_SQL', message: String(error.message) }, { status: 400 });
        }
      },
    };
    mf = new Miniflare(options);
    await mf.ready;
    return {
      database, mf, rpcCalls, outboundCalls,
      fetch: (path, init = {}) => mf.dispatchFetch(`https://panel.example.test${path}`, init),
      synchronizeInitialCreation() {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const timeout = setTimeout(() => resolve(), 5000);
        initialCreateBarrier = { count: 0, promise, resolve: () => { clearTimeout(timeout); resolve(); } };
      },
      async restart() {
        options.script += `\n// Test cold restart ${crypto.randomUUID()}\n`;
        await mf.setOptions(options);
        await mf.ready;
      },
      async close() { await mf.dispose(); await database.close(); },
    };
  } catch (error) {
    await mf?.dispose();
    await database.close();
    throw error;
  }
}

export function cookieJar(response) {
  const cookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') || '').split(/,(?=\s*cf_monitor_)/);
  return cookies.map(cookie => cookie.trim().split(';')[0]).filter(Boolean).join('; ');
}

export async function eventually(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Runtime condition did not become true before its deadline');
}
