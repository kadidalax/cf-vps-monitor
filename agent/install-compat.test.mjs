import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('./install.sh', import.meta.url), 'utf8').split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
const shellAvailable = spawnSync('sh', ['-c', ':'], { windowsHide: true }).status === 0;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const posix = value => value.replaceAll('\\', '/');

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'cf-agent-compat-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(dirname(resolved), parent);
    assert.ok(resolved.startsWith(parent + sep));
    assert.ok(resolved.slice(parent.length + 1).startsWith('cf-agent-compat-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

// Replace only absolute host filesystem probes/targets. The production shell
// grammar, conditionals and command arguments remain intact; no host service is used.
function sandboxSource(root) {
  const base = posix(root);
  const paths = [
    '/etc', '/run', '/proc/1', '/sbin/openrc-run', '/usr/sbin/openrc-run',
    '/opt', '/var/log',
  ].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?:${paths.join('|')})(?![A-Za-z0-9_.-])`, 'g');
  return source.replace(pattern, path => `${base}/host${path}`);
}

function assertShellSyntax(path) {
  const result = spawnSync('sh', ['-n', posix(path)], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `fixture must parse before testing installer behavior (${path}): ${result.stderr}`);
}

// External command names may contain hyphens; POSIX shell function names may not.
// Keep production calls intact and isolate executable shims through PATH.
function commandShims(root, commands) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  for (const [name, body] of Object.entries(commands)) {
    const path = join(root, 'bin', name);
    writeFileSync(path, `#!/usr/bin/env sh\nset -eu\n${body}\n`, { mode: 0o755 });
    assertShellSyntax(path);
  }
  return `
FIXTURE_BIN="$(cd "$ROOT/bin" && pwd)"
export PATH="$FIXTURE_BIN:$PATH"
for fixture_command in ${Object.keys(commands).join(' ')}; do
  [ "$(command -v "$fixture_command")" = "$FIXTURE_BIN/$fixture_command" ] || {
    echo '[fixture-error] command did not resolve to its isolated shim' >&2
    exit 90
  }
done
`;
}

function shell(root, content, { sandbox = false, timeout = 15000 } = {}) {
  const script = join(root, 'case.sh');
  writeFileSync(script, `${sandbox ? sandboxSource(root) : source}\nROOT=${quote(posix(root))}\nexport ROOT TMPDIR="$ROOT"\n${content}\n`);
  assertShellSyntax(script);
  const result = spawnSync('sh', [posix(script)], { encoding: 'utf8', timeout, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.doesNotMatch(result.stderr, /Syntax error:|Bad function name|\[fixture-error\]/i);
  return result;
}

function detectionFixture(t, scenario) {
  const root = fixture(t);
  mkdirSync(join(root, 'host/etc/init.d'), { recursive: true });
  if (scenario.manager === 'systemd') mkdirSync(join(root, 'host/run/systemd/system'), { recursive: true });
  if (scenario.manager === 'openrc') {
    mkdirSync(join(root, 'host/run/openrc'), { recursive: true });
    writeFileSync(join(root, 'host/run/openrc/softlevel'), 'default\n');
    mkdirSync(join(root, 'host/sbin'), { recursive: true });
    writeFileSync(join(root, 'host/sbin/openrc-run'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  mkdirSync(join(root, 'host/proc/1'), { recursive: true });
  writeFileSync(join(root, 'host/proc/1/comm'), `${scenario.manager === 'systemd' ? 'systemd' : 'init'}\n`);
  const pathSetup = commandShims(root, {
    systemctl: scenario.manager === 'systemd'
      ? (scenario.degraded ? "printf '%s\\n' degraded; exit 1" : "printf '%s\\n' running; exit 0")
      : "echo 'System has not been booted with systemd as init system' >&2; exit 1",
    'rc-status': "printf '%s\\n' default",
    'rc-service': `exit ${scenario.manager === 'openrc' ? '0' : '1'}`,
    'rc-update': `exit ${scenario.manager === 'openrc' ? '0' : '1'}`,
  });
  const result = shell(root, `
${pathSetup}
OS_NAME=linux; INSTALL_MODE=${quote(scenario.mode ?? 'auto')}
is_root() { return ${scenario.root === false ? '1' : '0'}; }
has() {
  case "$1" in
    systemctl) return ${scenario.systemctl ? '0' : '1'} ;;
    rc-service|rc-update|rc-status|openrc-run) return ${scenario.manager === 'openrc' ? '0' : '1'} ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}
detect_service_mode
`, { sandbox: true });
  return result;
}

for (const scenario of [
  { name: 'an installed but unavailable systemctl', systemctl: true, manager: 'none' },
  { name: 'a SysV init.d directory without OpenRC', systemctl: false, manager: 'none' },
]) {
  test(`compat auto falls back to user mode for ${scenario.name}`, { skip: !shellAvailable }, t => {
    const result = detectionFixture(t, scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'user', 'auto must not select a service manager that cannot run the Agent');
  });
  test(`compat explicit system mode rejects ${scenario.name}`, { skip: !shellAvailable }, t => {
    const result = detectionFixture(t, { ...scenario, mode: 'system' });
    assert.notEqual(result.status, 0, 'explicit system mode must report the unavailable service manager');
    assert.match(result.stderr, /systemd|OpenRC|service manager/i);
  });
}

for (const manager of ['systemd', 'openrc']) {
  test(`compat a running ${manager} remains selectable`, { skip: !shellAvailable }, t => {
    const result = detectionFixture(t, { manager, systemctl: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), manager);
  });
}

test('compat nonroot auto mode never selects a system service', { skip: !shellAvailable }, t => {
  const result = detectionFixture(t, { manager: 'systemd', systemctl: true, root: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'user');
});

test('compat nonroot explicit system mode fails before system installation', { skip: !shellAvailable }, t => {
  const result = detectionFixture(t, { manager: 'systemd', systemctl: true, root: false, mode: 'system' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires root/);
});

test('compat a degraded running systemd still owns system services', { skip: !shellAvailable }, t => {
  const result = detectionFixture(t, { manager: 'systemd', systemctl: true, degraded: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'systemd');
});

function userCronFixture(t, cronMode) {
  const root = fixture(t);
  mkdirSync(join(root, 'bin'));
  const cronBefore = ['no-table', 'busybox-no-table'].includes(cronMode) ? '' : '15 * * * * unrelated-job # keep-me\n';
  writeFileSync(join(root, 'cron.txt'), cronBefore);
  writeFileSync(join(root, 'bin/crontab'), `#!/bin/sh
if [ "$1" = -l ]; then
  if [ "$CF_MONITOR_TEST_CRON_MODE" = read-denied ]; then echo 'crontab: permission denied' >&2; exit 1; fi
  if [ "$CF_MONITOR_TEST_CRON_MODE" = no-table ]; then echo 'no crontab for fixture' >&2; exit 1; fi
  if [ "$CF_MONITOR_TEST_CRON_MODE" = busybox-no-table ]; then echo "crontab: can't open 'fixture': No such file or directory" >&2; exit 1; fi
  cat "$CF_MONITOR_TEST_CRON"
else
  if [ "$CF_MONITOR_TEST_CRON_MODE" = write-denied ]; then echo 'crontab: permission denied' >&2; exit 1; fi
  cp "$1" "$CF_MONITOR_TEST_CRON"
fi
`, { mode: 0o755 });
  writeFileSync(join(root, 'agent-fixture'), `#!/bin/sh
printf '%s\\n' "$$" >> "$CF_MONITOR_TEST_PIDS"
printf '%s\\n' fixture-running > "$CF_MONITOR_TEST_OUTPUT"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`, { mode: 0o755 });
  const result = shell(root, `
export XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state"
export CF_MONITOR_TEST_CRON="$ROOT/cron.txt" CF_MONITOR_TEST_CRON_MODE=${quote(cronMode)}
export CF_MONITOR_TEST_PIDS="$ROOT/processes.txt" CF_MONITOR_TEST_OUTPUT="$ROOT/running.txt"
FIXTURE_BIN="$(cd "$ROOT/bin" && pwd)"
export PATH="$FIXTURE_BIN:$PATH"
[ "$(command -v crontab)" = "$FIXTURE_BIN/crontab" ] || { echo 'Unsafe crontab fixture path' >&2; exit 90; }
${cronMode === 'missing' ? 'has() { [ "$1" != crontab ] && command -v "$1" >/dev/null 2>&1; }' : ''}
is_root() { return 1; }
INSTALL_MODE=auto; SERVICE_MODE="$(detect_service_mode)"
INSTALL_DIR=''; SERVICE_NAME=''; INSTANCE_ID=fixture; DRY_RUN=0
SERVER=https://monitor.example.test; TOKEN=synthetic-token; NODE_NAME=fixture
apply_defaults
WORK_BIN="$ROOT/agent-fixture"
eval "$(user_process_helpers)"
cleanup() {
  if [ -f "$CF_MONITOR_TEST_PIDS" ]; then
    while IFS= read -r cleanup_pid; do
      if user_agent_matches "$cleanup_pid" "$INSTALL_DIR/cf-vps-monitor-agent"; then kill "$cleanup_pid" 2>/dev/null || true; fi
    done < "$CF_MONITOR_TEST_PIDS"
    sleep 1
  fi
}
trap cleanup EXIT
set +e
install_user_mode
install_status=$?
set -e
alive=0
if [ -s "$PID_FILE" ]; then
  candidate_pid="$(head -n 1 "$PID_FILE")"
  if user_agent_matches "$candidate_pid" "$INSTALL_DIR/cf-vps-monitor-agent"; then alive=1; fi
fi
printf 'RESULT:%s:%s:%s\\n' "$install_status" "$alive" "$INSTALL_DIR"
`, { timeout: 35000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const outcome = result.stdout.match(/RESULT:(\d+):(\d+):([^\r\n]+)/);
  assert.ok(outcome, `${result.stdout}\n${result.stderr}`);
  return {
    output: result.stdout + result.stderr,
    status: Number(outcome[1]), alive: Number(outcome[2]),
    installDir: outcome[3], expectedInstallDir: `${posix(root)}/data/cf-vps-monitor/fixture`,
    cron: readFileSync(join(root, 'cron.txt'), 'utf8'), cronBefore,
    started: existsSync(join(root, 'running.txt')),
    cronScratch: readdirSync(root).filter(name => name.startsWith('cf-vps-monitor-cron.')),
  };
}

for (const cronMode of ['missing', 'read-denied', 'write-denied']) {
  test(`compat ${cronMode} crontab preserves a running user Agent and unrelated jobs`, { skip: !shellAvailable }, t => {
    const result = userCronFixture(t, cronMode);
    assert.equal(result.started, true, 'the isolated Agent must have actually started');
    assert.equal(result.status, 0, result.output);
    assert.equal(result.alive, 1, 'optional autostart failure must not roll back a running Agent');
    assert.equal(result.installDir, result.expectedInstallDir, 'nonroot installation belongs in the user data directory');
    assert.equal(result.cron, result.cronBefore, 'an unreadable or unwritable crontab must leave unrelated jobs intact');
    assert.deepEqual(result.cronScratch, [], 'autostart attempts must clean up their temporary crontab copies');
    assert.match(result.output, /(?:autostart[^\r\n]*(?:not configured|unavailable|disabled)|(?:cannot|could not|unable|failed)[^\r\n]*autostart)/i);
    assert.doesNotMatch(result.output, /Autostart: crontab @reboot configured\./);
  });
}

test('compat permitted crontab keeps existing jobs and adds this user Agent once', { skip: !shellAvailable }, t => {
  const result = userCronFixture(t, 'allowed');
  assert.equal(result.status, 0, result.output);
  assert.equal(result.alive, 1);
  assert.ok(result.cron.startsWith(result.cronBefore));
  assert.equal((result.cron.match(/# cf-vps-monitor:fixture/g) ?? []).length, 1);
  assert.match(result.cron, /^@reboot .*\/start\.sh.* # cf-vps-monitor:fixture$/m);
  assert.deepEqual(result.cronScratch, []);
});

for (const cronMode of ['no-table', 'busybox-no-table']) {
  test(`compat ${cronMode} allows first-time user autostart registration`, { skip: !shellAvailable }, t => {
    const result = userCronFixture(t, cronMode);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.alive, 1);
    assert.match(result.cron, /^@reboot .*\/start\.sh.* # cf-vps-monitor:fixture$/m);
    assert.match(result.output, /Autostart: crontab @reboot configured\./);
    assert.deepEqual(result.cronScratch, []);
  });
}

test('compat mixed missing-table errors cannot replace an existing crontab', { skip: !shellAvailable }, t => {
  const root = fixture(t);
  const cronBefore = '15 * * * * unrelated-job # keep-me\n';
  writeFileSync(join(root, 'cron.txt'), cronBefore);
  const result = shell(root, `
BASE_ID=fixture; INSTALL_DIR="$ROOT/user-agent"; DRY_RUN=0
crontab() {
  if [ "$1" = -l ]; then
    printf 'no crontab for fixture\\npermission denied' >&2
    return 1
  fi
  cp "$1" "$ROOT/cron.txt"
}
install_user_autostart
`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(join(root, 'cron.txt'), 'utf8'), cronBefore, 'partial error output must not be mistaken for a confirmed empty crontab');
  assert.doesNotMatch(result.stdout, /Autostart: crontab @reboot configured\./);
});

const nativeRoot = process.platform !== 'win32' && process.getuid?.() === 0 && shellAvailable;
const nobodyUid = nativeRoot ? spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }) : null;
const nobodyGid = nativeRoot ? spawnSync('id', ['-g', 'nobody'], { encoding: 'utf8' }) : null;
const nativePrivilegeFixture = nativeRoot && nobodyUid.status === 0 && nobodyGid.status === 0 && Number(nobodyUid.stdout.trim()) > 0 && Number(nobodyUid.stdout.trim()) <= 2147483647 && nobodyUid.stdout.trim() === nobodyGid.stdout.trim();

function nativeSystemFixture(t, manager, custom = false) {
  const root = fixture(t);
  chmodSync(root, 0o755);
  for (const directory of ['host', 'host/opt', 'host/etc', 'host/etc/systemd', 'host/etc/systemd/system', 'host/run', 'host/var', 'host/var/log']) {
    mkdirSync(join(root, directory), { recursive: true });
    chmodSync(join(root, directory), 0o755);
  }
  const privateParent = join(root, 'private');
  if (custom) {
    mkdirSync(privateParent, { mode: 0o700 });
    chmodSync(privateParent, 0o700);
  }
  writeFileSync(join(root, 'agent-fixture'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pathSetup = commandShims(root, {
    systemctl: `
case "$*" in
  daemon-reload|'enable cf-vps-monitor-agent-fixture'|'restart cf-vps-monitor-agent-fixture') ;;
  *) echo '[fixture-error] unexpected systemctl arguments' >&2; exit 91 ;;
esac
printf 'systemctl:%s\\n' "$*" >> "$ROOT/service-events"
`,
    'rc-service': `
[ "$#" -eq 2 ] && [ "$1" = cf-vps-monitor-agent-fixture ] && [ "$2" = restart ] || {
  echo '[fixture-error] unexpected rc-service arguments' >&2; exit 92
}
printf 'rc-service:%s\\n' "$*" >> "$ROOT/service-events"
`,
    'rc-update': `
[ "$#" -eq 3 ] && [ "$1" = add ] && [ "$2" = cf-vps-monitor-agent-fixture ] && [ "$3" = default ] || {
  echo '[fixture-error] unexpected rc-update arguments' >&2; exit 93
}
printf 'rc-update:%s\\n' "$*" >> "$ROOT/service-events"
`,
  });
  const result = shell(root, `
${pathSetup}
OS_NAME=linux; SERVICE_MODE=${quote(manager)}; AGENT_USER=${quote(nobodyUid.stdout.trim())}
INSTALL_DIR=${quote(custom ? posix(join(privateParent, 'fixture')) : '')}; SERVICE_NAME=''; INSTANCE_ID=fixture; DRY_RUN=0
SERVER=https://monitor.example.test; TOKEN=synthetic-token
apply_defaults
WORK_BIN="$ROOT/agent-fixture"
ensure_agent_user() { :; }
umask 077
install_${manager}
`, { sandbox: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Installed cf-vps-monitor-agent-fixture\./, 'permission assertions require an installation that actually completed');
  assert.deepEqual(readFileSync(join(root, 'service-events'), 'utf8').trim().split('\n'), manager === 'systemd'
    ? ['systemctl:daemon-reload', 'systemctl:enable cf-vps-monitor-agent-fixture', 'systemctl:restart cf-vps-monitor-agent-fixture']
    : ['rc-update:add cf-vps-monitor-agent-fixture default', 'rc-service:cf-vps-monitor-agent-fixture restart']);
  const installDir = custom ? join(privateParent, 'fixture') : join(root, 'host/opt/cf-vps-monitor/fixture');
  assert.ok(existsSync(join(installDir, 'cf-vps-monitor-agent')), 'installation must create the actual Agent file before checking permissions');
  return { root, result, privateParent, installDir };
}

for (const manager of ['systemd', 'openrc']) {
  const nativeOptions = {
    skip: nativePrivilegeFixture ? false : 'requires native Unix root and an existing nobody account with matching numeric UID/GID',
  };
  test(`compat ${manager} default paths allow the service user under umask 077`, nativeOptions, t => {
    const { result, installDir } = nativeSystemFixture(t, manager);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const access = spawnSync('sh', ['-c', 'test -x "$1" && test -r "$1" && test -w "$2"', 'fixture', join(installDir, 'cf-vps-monitor-agent'), join(installDir, 'state')], {
      encoding: 'utf8', uid: Number(nobodyUid.stdout.trim()), gid: Number(nobodyGid.stdout.trim()),
    });
    assert.ifError(access.error);
    assert.equal(access.status, 0, 'the actual unprivileged service user cannot execute the Agent or write its state');
  });
  test(`compat ${manager} must not open permissions on a private custom parent`, nativeOptions, t => {
    const { privateParent } = nativeSystemFixture(t, manager, true);
    assert.equal(statSync(privateParent).mode & 0o777, 0o700, 'the installer must not expose an existing private parent directory');
  });
}
