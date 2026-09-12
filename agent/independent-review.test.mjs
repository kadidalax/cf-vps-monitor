import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const fixtureParent = join(repo, 'worker', '.tmp', 'independent-agent-review');

function shellPath(value) {
  const slashed = value.replaceAll('\\', '/');
  return windows ? slashed.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`) : slashed;
}

const shellQuote = value => `'${shellPath(value).replaceAll("'", "'\\''")}'`;

function bashExecutable() {
  if (!windows) return 'bash';
  const found = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(found.error);
  assert.equal(found.status, 0);
  return join(dirname(dirname(found.stdout.trim().split(/\r?\n/)[0])), 'bin', 'bash.exe');
}

function dryRun(t, scriptName, platform, serviceName) {
  mkdirSync(fixtureParent, { recursive: true });
  const parent = realpathSync(fixtureParent);
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(dirname(resolved), parent);
    assert.ok(resolved.startsWith(parent + sep));
    rmSync(resolved, { recursive: true, force: true });
  });
  const binary = join(root, 'synthetic-agent');
  writeFileSync(binary, 'Synthetic bytes. Dry-run must never execute this file.\n');
  let installer = join(repo, 'agent', scriptName);
  if (scriptName === 'install.sh' && platform === 'Linux') {
    const systemdDirectory = join(root, 'run/systemd/system');
    const initCommand = join(root, 'proc/1/comm');
    mkdirSync(systemdDirectory, { recursive: true });
    mkdirSync(dirname(initCommand), { recursive: true });
    writeFileSync(initCommand, 'systemd\n');
    // Supply an active init environment without bypassing production detection.
    const source = readFileSync(installer, 'utf8')
      .replaceAll('/run/systemd/system', shellQuote(systemdDirectory))
      .replaceAll('/proc/1/comm', shellQuote(initCommand));
    installer = join(root, 'install-under-test.sh');
    writeFileSync(installer, source);
  }
  const wrapper = join(root, 'entry.sh');
  // Only model OS identity and the service-manager boundary. Keep the complete
  // product argument parser, path/resource ownership checks and dry-run branch.
  // Environment transport preserves a newline-containing name as one Windows argv.
  writeFileSync(wrapper, `#!/bin/sh
uname() { case "$1" in -s) printf '%s\\n' "$REVIEW_PLATFORM" ;; -m) printf 'x86_64\\n' ;; *) return 2 ;; esac; }
id() { if [ "$1" = -u ]; then printf '0\\n'; else return 2; fi; }
systemctl() { printf 'UNEXPECTED_REAL_MANAGER\\n' >&2; return 99; }
launchctl() { printf 'UNEXPECTED_REAL_MANAGER\\n' >&2; return 99; }
review_installer="$1"
shift
set -- --service-name "$REVIEW_SERVICE_NAME" "$@"
. "$review_installer"
`);
  const args = [shellPath(wrapper), shellPath(installer),
    '--dry-run', '--instance-id', 'review-fixture',
    '--install-dir', shellPath(join(root, 'owned-instance')),
    '--server', 'https://monitor.example.test', '--token', 'synthetic-review-token',
    '--binary', shellPath(binary)];
  if (scriptName === 'install.sh') args.push('--install-mode', 'system');
  const result = spawnSync(scriptName === 'install.sh' ? 'sh' : bashExecutable(), args, {
    cwd: repo, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, REVIEW_PLATFORM: platform, REVIEW_SERVICE_NAME: serviceName,
      XDG_DATA_HOME: shellPath(join(root, 'data')),
      XDG_CONFIG_HOME: shellPath(join(root, 'config')),
      XDG_STATE_HOME: shellPath(join(root, 'state')),
      TMPDIR: shellPath(root) },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, null);
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_REAL_MANAGER/);
  return result;
}

test('independent R-A01/R-A06 ordinary custom service names retain their install plan', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) for (const platform of ['Linux', 'Darwin']) {
    for (const serviceName of ['local-monitor-review', 'local.review_1@node-2']) {
      await t.test(`${script} ${platform} ${serviceName}`, t => {
        const result = dryRun(t, script, platform, serviceName);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /\[dry-run\]/);
      });
    }
  }
});

test('independent R-A01/R-A06 service names cannot escape their resource path before a mutation plan', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) for (const platform of ['Linux', 'Darwin']) {
    for (const serviceName of ['../../../tmp/review-escaped', 'safe-name\n../../../tmp/review-escaped', '-review-option']) {
      await t.test(`${script} ${platform} ${JSON.stringify(serviceName)}`, t => {
        const result = dryRun(t, script, platform, serviceName);
        assert.notEqual(result.status, 0, `unsafe service name formed a successful install plan:\n${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /--service-name/, 'the service-name check must cause the rejection');
        assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'reject before any stop/write/install plan');
      });
    }
  }
});
