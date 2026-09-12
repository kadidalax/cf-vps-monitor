import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deploymentUrl = new URL('./deploy-cloudflare.mjs', import.meta.url);
const deploymentSource = await readFile(deploymentUrl, 'utf8');

function runDeployment({ verificationStatus = 0, ciGateStatus = 0, buildStatus = 0, args = [], preparationFails = false, env = {}, checkoutChangesDuringBuild = false } = {}) {
  const imports = deploymentSource.match(/^import .+;\r?$/gm) || [];
  assert.ok(imports.length >= 4, 'execute the actual deploy script with explicit I/O replacements');
  const source = deploymentSource.replace(/^import .+;\r?$/gm, '').replaceAll('import.meta.url', JSON.stringify(deploymentUrl.href));
  const calls = [];
  const writes = [];
  class Exit extends Error { constructor(status) { super('fixture process exit'); this.status = status; } }
  const fakeProcess = { platform: process.platform, execPath: process.execPath, argv: ['node', fileURLToPath(deploymentUrl), ...args],
    env: { SUPABASE_URL: 'https://synthetic.supabase.co', JWT_SECRET: 'synthetic-jwt-secret', SUPABASE_SECRET_KEY: 'sb_secret_synthetic', ...env },
    exit: status => { throw new Exit(status); } };
  const spawn = (command, argv) => {
    calls.push({ command, args: argv });
    if (/npm(?:\.cmd)?$/.test(command)) return { status: argv[1] === 'build' ? buildStatus : verificationStatus, stdout: '', stderr: '' };
    if (argv[0]?.endsWith('github-ci-gate.mjs')) return { status: ciGateStatus, stdout: '', stderr: '' };
    if (command === 'git' && argv[0] === 'diff') return { status: checkoutChangesDuringBuild ? 1 : 0, stdout: '', stderr: '' };
    if (command === 'git') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (argv[0]?.endsWith('wrangler.js')) return { status: 0, stdout: '[]', stderr: '' };
    throw new Error(`Unexpected fixture command: ${command}`);
  };
  let status = 0;
  try {
    new Function('mkdirSync', 'readFileSync', 'rmSync', 'writeFileSync', 'dirname', 'join', 'fileURLToPath', 'spawnSync', 'process', 'console', 'prepareCloudflareVerificationEnv', source)(
      path => writes.push(path),
      () => 'name = "synthetic-worker"\nmain = "worker/src/index.ts"\n[vars]\nSUPABASE_URL = "https://PROJECT_REF.supabase.co"\n',
      path => writes.push(path), path => writes.push(path), dirname, join, fileURLToPath, spawn, fakeProcess,
      { log() {}, error() {} },
      () => { if (preparationFails) throw new Error('Synthetic tool preparation failure'); return fakeProcess.env; },
    );
  } catch (error) { if (!(error instanceof Exit)) throw error; status = error.status; }
  return { status, calls, writes };
}

test('AUD-19 behavior-test failure stops deployment before configuration or Wrangler side effects', () => {
  const result = runDeployment({ verificationStatus: 1 });
  assert.notEqual(result.status, 0, 'failed verification must fail the deployment entrypoint');
  assert.equal(result.calls.filter(call => call.args[0]?.endsWith('wrangler.js')).length, 0);
  assert.equal(result.writes.length, 0);
});

test('missing build tools stop deployment before verification or Cloudflare side effects', () => {
  const result = runDeployment({ preparationFails: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 0);
  assert.equal(result.writes.length, 0);
});

test('AUD-19 successful verification precedes deployment and preserves requested target arguments', () => {
  const result = runDeployment({ args: ['--name', 'synthetic-target', '--keep-vars'] });
  assert.equal(result.status, 0);
  const verification = result.calls.findIndex(call => call.args.join(' ') === 'run verify');
  const deploy = result.calls.findIndex(call => call.args.includes('deploy'));
  assert.ok(verification >= 0 && verification < deploy, 'full verification must precede the actual deploy subprocess');
  assert.ok(result.calls[deploy].args.includes('synthetic-target'));
});

test('AUD-19 local dry-run remains a build inspection without publishing or recursive verification', () => {
  const result = runDeployment({ args: ['--dry-run'], verificationStatus: 1 });
  assert.equal(result.status, 0);
  assert.equal(result.calls.some(call => call.args.join(' ') === 'run verify'), false);
  assert.ok(result.calls.find(call => call.args.includes('deploy')).args.includes('--dry-run'));
});

test('Workers Builds reuses successful commit CI before building and publishing without rerunning tests', () => {
  const result = runDeployment({ env: { WORKERS_CI: '1' }, verificationStatus: 1, preparationFails: true });
  assert.equal(result.status, 0, 'Cloudflare must not prepare or rerun local full verification after CI has passed');
  const ci = result.calls.findIndex(call => call.args[0]?.endsWith('github-ci-gate.mjs'));
  const build = result.calls.findIndex(call => call.args.join(' ') === 'run build');
  const deploy = result.calls.findIndex(call => call.args.includes('deploy'));
  assert.ok(ci >= 0 && ci < build && build < deploy, 'commit CI and a fresh build must precede publication');
  assert.equal(result.calls.some(call => call.args.join(' ') === 'run verify'), false);
});

test('Workers Builds cannot publish or build after failed or unavailable GitHub CI verification', () => {
  for (const ciGateStatus of [1, null]) {
    const result = runDeployment({ env: { WORKERS_CI: '1' }, ciGateStatus });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.some(call => /npm(?:\.cmd)?$/.test(call.command)), false);
    assert.equal(result.calls.some(call => call.args[0]?.endsWith('wrangler.js')), false);
    assert.equal(result.writes.length, 0);
  }
});

test('Workers Builds build failures and changed source still stop publication after successful CI', () => {
  for (const options of [{ buildStatus: 1 }, { checkoutChangesDuringBuild: true }]) {
    const result = runDeployment({ env: { WORKERS_CI: '1' }, ...options });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.some(call => call.args[0]?.endsWith('wrangler.js')), false);
    assert.equal(result.writes.length, 0);
  }
});

test('generic CI flags cannot bypass full local verification', () => {
  const result = runDeployment({ env: { CI: 'true' }, verificationStatus: 1 });
  assert.notEqual(result.status, 0);
  assert.ok(result.calls.some(call => call.args.join(' ') === 'run verify'));
  assert.equal(result.calls.some(call => call.args[0]?.endsWith('wrangler.js')), false);
});

test('AUD-19 GitHub release job cannot run after its same-checkout verification job failed', async () => {
  const source = await readFile(new URL('../.github/workflows/release-agent.yml', import.meta.url), 'utf8');
  const jobs = new Map();
  let current;
  for (const line of source.split(/\r?\n/)) {
    const job = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (job) { current = { needs: [], always: false }; jobs.set(job[1], current); }
    const needs = line.match(/^    needs: (.+)$/);
    if (needs && current) current.needs = needs[1].replace(/[\[\]'" ]/g, '').split(',');
    if (/^    if:.*always\(\)/.test(line) && current) current.always = true;
  }
  const release = jobs.get('release-agent');
  assert.ok(release, 'consumer loads the actual publication job');
  const ready = statuses => release.always || release.needs.every(name => statuses[name] === 'success');
  assert.equal(ready({ verify: 'failure' }), false, 'failed CI must prevent release publication');
  assert.equal(ready({ verify: 'success' }), true);
  assert.ok(release.needs.every(name => jobs.has(name)), 'every required verification job is defined');
});
