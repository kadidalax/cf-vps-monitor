import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareCloudflareVerificationEnv } from './cloudflare-build-tools.mjs';

function fixture(t, { corrupt = false, installed = false, ready = true, downloadStatus = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cfm-build-tools-'));
  t.after(() => {
    assert.equal(dirname(root), tmpdir());
    assert.ok(root.startsWith(join(tmpdir(), 'cfm-build-tools-')));
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('synthetic verified release archive');
  const release = { version: 'synthetic', url: 'https://example.invalid/powershell.tar.gz',
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const env = { WORKERS_CI: 'true', PATH: '/existing/tools', KEEP: 'unchanged' };
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'pwsh') return { status: installed ? 0 : null };
    if (command === 'curl') {
      if (downloadStatus === 0) writeFileSync(args[args.indexOf('--output') + 1], corrupt ? 'corrupt archive' : bytes);
      return { status: downloadStatus };
    }
    if (command === 'tar') {
      writeFileSync(join(args[args.indexOf('--directory') + 1], 'pwsh'), 'synthetic executable');
      return { status: 0 };
    }
    return { status: ready ? 0 : 127 };
  };
  return { options: { root, env, platform: 'linux', arch: 'x64', run, release, log() {} }, calls, env };
}

test('ordinary local/CI verification does not download tools or mutate its environment', t => {
  const { options, calls, env } = fixture(t);
  assert.equal(prepareCloudflareVerificationEnv({ ...options, env: { PATH: env.PATH } }).PATH, env.PATH);
  assert.equal(prepareCloudflareVerificationEnv({ ...options, platform: 'win32' }), env);
  assert.equal(calls.length, 0);
});

test('Workers Builds reuses a working PowerShell installation', t => {
  const { options, calls, env } = fixture(t, { installed: true });
  assert.equal(prepareCloudflareVerificationEnv(options), env);
  assert.deepEqual(calls.map(call => call.command), ['pwsh']);
});

test('Workers Builds supplies the verified executable to the child environment', t => {
  const { options, calls, env } = fixture(t);
  const result = prepareCloudflareVerificationEnv(options);
  assert.equal(result.KEEP, 'unchanged');
  assert.equal(env.PATH, '/existing/tools');
  assert.notEqual(result, env);
  assert.equal(result.PATH, `${dirname(calls.at(-1).command)}:${env.PATH}`);
  assert.deepEqual(calls.slice(0, 3).map(call => call.command), ['pwsh', 'curl', 'tar']);
});

test('a corrupt download is rejected before extraction or execution', t => {
  const { options, calls } = fixture(t, { corrupt: true });
  assert.throws(() => prepareCloudflareVerificationEnv(options), /SHA256 mismatch/);
  assert.deepEqual(calls.map(call => call.command), ['pwsh', 'curl']);
});

test('download and native runtime failures stop verification instead of skipping tests', t => {
  const download = fixture(t, { downloadStatus: 22 });
  assert.throws(() => prepareCloudflareVerificationEnv(download.options), /Could not download/);
  assert.equal(download.calls.length, 2);
  const runtime = fixture(t, { ready: false });
  assert.throws(() => prepareCloudflareVerificationEnv(runtime.options), /cannot run in this build image/);
});
