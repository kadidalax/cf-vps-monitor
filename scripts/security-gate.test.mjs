import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const cleanNpm = { status: 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }), stderr: '' };
const cleanGo = { status: 0, stdout: 'No vulnerabilities found.\n', stderr: '' };
const vulnerableNpm = { status: 1, stdout: JSON.stringify({ auditReportVersion: 2,
  vulnerabilities: { hono: { severity: 'high', via: ['GHSA-synthetic'] } },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } }), stderr: '' };

// Traverse the actual checked-in verification entrypoints. Builds and behavior
// tests pass in this fixture so only the scanner boundary can block publication.
async function fixture({ npm = cleanNpm, go = cleanGo, commands = ['npm run verify'] } = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('audit')) return typeof npm === 'function' ? npm(args) : npm;
    if (args.some(arg => arg.includes('govulncheck'))) return go;
    throw new Error(`Unexpected security subprocess: ${command} ${args.join(' ')}`);
  };
  async function execute(command) {
    for (const step of command.split(/\s*&&\s*/)) {
      const npmStep = /^npm (?:run )?([\w:-]+)$/.exec(step.trim());
      if (npmStep) {
        const name = npmStep[1];
        if (['ci', 'lint', 'build', 'test'].includes(name)) continue;
        assert.equal(typeof packageJson.scripts[name], 'string', `npm script ${name} exists`);
        await execute(packageJson.scripts[name]);
        continue;
      }
      const nodeStep = /^node (\S+\.mjs)$/.exec(step.trim());
      assert.ok(nodeStep, `fixture must execute the actual supported command: ${step}`);
      const module = await import(new URL(nodeStep[1], root));
      await module.runSecurityChecks({ run, log() {} });
    }
  }
  try {
    for (const command of commands) await execute(command);
    return { status: 0, calls };
  } catch (error) {
    return { status: 1, calls, error };
  }
}

test('AUD-20 full verification rejects npm findings even if a scanner incorrectly exits zero', async () => {
  for (const status of [1, 0]) {
    const result = await fixture({ npm: { ...vulnerableNpm, status } });
    assert.equal(result.status, 1, 'a successful build/test cannot bypass vulnerable dependencies');
    assert.ok(result.calls.some(call => call.args.includes('audit')), 'the real npm audit boundary ran');
  }
});

test('AUD-20 security verification includes vulnerable build dependencies even in production environments', async () => {
  const result = await fixture({ npm: args => args.includes('--include=dev') ? vulnerableNpm : cleanNpm });
  assert.equal(result.status, 1, 'NODE_ENV=production must not silently omit the Wrangler/build/test dependency graph');
});

test('AUD-20 an npm-launched gate invokes that npm CLI directly without a Windows shell', async () => {
  const original = process.env.npm_execpath;
  const cli = new URL('synthetic-npm-cli.js', root).pathname;
  process.env.npm_execpath = cli;
  try {
    const result = await fixture();
    assert.equal(result.status, 0, result.error?.stack);
    const npm = result.calls.find(call => call.args.includes('audit'));
    assert.equal(npm.command, process.execPath);
    assert.equal(npm.args[0], cli);
    assert.notEqual(npm.options.shell, true);
  } finally {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  }
});

test('AUD-20 full verification rejects Go findings, including govulncheck JSON exit-zero output', async () => {
  for (const go of [
    { status: 3, stdout: 'Vulnerability #1: GO-2026-SYNTHETIC\nYour code is affected by 1 vulnerability.\n' },
    { status: 0, stdout: '{"finding":{"osv":"GO-2026-SYNTHETIC","trace":[{"function":"Affected"}]}}\n' },
  ]) {
    const result = await fixture({ go });
    assert.equal(result.status, 1, 'Go findings must block verification regardless of the process exit alone');
    assert.ok(result.calls.some(call => call.args.some(arg => arg.includes('govulncheck'))));
  }
});

test('AUD-20 scanner failures and incomplete output fail closed', async () => {
  for (const npm of [
    { status: null, error: new Error('scanner unavailable'), stdout: '' },
    { status: 1, stdout: cleanNpm.stdout, stderr: 'registry unavailable' },
    { status: 0, stdout: '<html>registry unavailable</html>' },
    { status: 0, stdout: '{}' },
    { status: 0, stdout: JSON.stringify({ ...JSON.parse(cleanNpm.stdout), vulnerabilities: { affected: {} } }) },
    { status: 0, stdout: JSON.stringify({ ...JSON.parse(cleanNpm.stdout), metadata: { vulnerabilities: { total: 0 } } }) },
  ]) {
    assert.equal((await fixture({ npm })).status, 1, 'npm must return a complete clean scan');
  }
  for (const go of [
    { status: null, error: new Error('scanner unavailable'), stdout: '' },
    { status: 1, stdout: 'No vulnerabilities found.', stderr: 'incomplete scan' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '{"config":{"scanner_name":"govulncheck"}}\n' },
    { status: 0, stdout: 'Vulnerability #1: GO-2026-SYNTHETIC\nNo vulnerabilities found.\n' },
  ]) {
    assert.equal((await fixture({ go })).status, 1, 'Go must return a complete clean text scan');
  }
});

test('AUD-20 clean scans allow verification only after both npm and the actual Agent toolchain are scanned', async () => {
  const result = await fixture();
  assert.equal(result.status, 0, result.error?.stack);
  assert.equal(result.calls.length, 2, 'both scanners are mandatory');
  const go = result.calls.find(call => call.args.some(arg => arg.includes('govulncheck')));
  assert.ok(go.options.cwd.replaceAll('\\', '/').endsWith('/agent'));
  assert.equal(go.args.includes('-json'), false, 'default text mode preserves govulncheck finding exit semantics');
  assert.ok(go.args.includes('golang.org/x/vuln/cmd/govulncheck@v1.7.0'));
});

test('AUD-20 the reusable CI gate blocks same-checkout Agent publishing when security fails', async () => {
  const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  const release = await readFile(new URL('.github/workflows/release-agent.yml', root), 'utf8');
  const commands = [...ci.matchAll(/^\s+run: (npm (?:run )?[\w:-]+)\s*$/gm)].map(match => match[1]);
  assert.ok(commands.length >= 3, 'exercise the actual CI command chain');
  assert.match(release, /^  verify:\r?\n    uses: \.\/\.github\/workflows\/ci\.yml\s*$/m);
  assert.match(release, /^  release-agent:\r?\n    needs: verify\s*$/m);
  assert.doesNotMatch(release, /^    if:.*always\(\)/m);
  const result = await fixture({ npm: vulnerableNpm, commands });
  const canPublish = result.status === 0;
  assert.equal(canPublish, false, 'the same-checkout reusable CI must fail before release-agent can publish');
  const success = await fixture({ commands });
  assert.equal(success.status, 0, success.error?.stack);
  assert.equal(success.calls.length, 2);
});
