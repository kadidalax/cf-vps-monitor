import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtureParent = join(repo, '.tmp', 'openrc-installer-tests');
const installer = readFileSync(new URL('./install.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const shellAvailable = spawnSync('sh', ['-c', ':'], { windowsHide: true }).status === 0;
const posix = value => value.replaceAll('\\', '/');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const serviceName = 'cf-vps-monitor-agent-openrc-fixture';

function fixture(t, scenario = 'prepare') {
  mkdirSync(fixtureParent, { recursive: true });
  const parent = realpathSync(fixtureParent);
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(dirname(resolved), parent, 'cleanup is limited to this fixture');
    assert.ok(resolved.startsWith(parent + sep));
    rmSync(resolved, { recursive: true, force: true });
  });
  for (const child of ['bin', 'etc/conf.d', 'etc/init.d', 'var/log', 'run', 'temp']) mkdirSync(join(root, child), { recursive: true });
  const agent = scenario === 'exits'
    ? '#!/bin/sh\nprintf "synthetic startup failure\\n"\nexit 7\n'
    : '#!/bin/sh\ntrap "exit 0" TERM INT\nprintf "synthetic agent running\\n"\nwhile :; do sleep 0.1; done\n';
  writeFileSync(join(root, 'synthetic-agent'), agent, { mode: 0o755 });
  const source = installer
    .replaceAll('/etc/conf.d', posix(join(root, 'etc/conf.d')))
    .replaceAll('/etc/init.d', posix(join(root, 'etc/init.d')))
    .replaceAll('/var/log/', posix(join(root, 'var/log')) + '/')
    .replaceAll('/run/', posix(join(root, 'run')) + '/')
    .split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
  const boundaries = `
fixture_rc_update() {
  [ "$#" -eq 3 ] && [ "$1" = add ] && [ "$2" = "$SERVICE_NAME" ] && [ "$3" = default ] || return 94
  printf '%s\\n' rc-update >> "$ROOT/events"
}
eerror() { printf '%s\\n' "$*" >&2; }
checkpath() {
  _fixture_type=''; _fixture_mode=''; _fixture_owner=''
  while [ "$#" -gt 1 ]; do
    case "$1" in
      -d|-f) _fixture_type="$1"; shift ;;
      -m) _fixture_mode="$2"; shift 2 ;;
      -o) _fixture_owner="$2"; shift 2 ;;
      *) return 90 ;;
    esac
  done
  case "$1" in "$ROOT"/*) ;; *) return 91 ;; esac
  if [ "$CF_SCENARIO" = state-failure ] && [ "$_fixture_type" = -d ]; then
    printf 'failure:%s\\n' "$CF_SCENARIO" >> "$ROOT/events"
    return 23
  fi
  if [ "$CF_SCENARIO" = log-failure ] && [ "$_fixture_type" = -f ]; then
    printf 'failure:%s\\n' "$CF_SCENARIO" >> "$ROOT/events"
    return 24
  fi
  case "$_fixture_type" in
    -d) mkdir -p "$1" || return 1 ;;
    -f)
      if [ ! -e "$1" ]; then (umask 077; set -C; : > "$1") || return 1; fi
      [ -f "$1" ] || return 1 ;;
    *) return 92 ;;
  esac
  chmod "$_fixture_mode" "$1" || return 1
}
# Model the documented start-stop-daemon --wait boundary using a real child.
# This is not a substitute for native OpenRC ownership and daemon matching tests.
fixture_start_stop_daemon() {
  _fixture_wait=0
  while [ "$#" -gt 0 ]; do
    case "$1" in --wait|-w) _fixture_wait="$2"; shift 2 ;; *) return 93 ;; esac
  done
  "$command" --interval 3 --ping-interval 120 >> "$output_log" 2>> "$error_log" &
  _fixture_pid=$!
  printf '%s\\n' "$_fixture_pid" > "$pidfile"
  printf '%s\\n' "$_fixture_pid" >> "$ROOT/children"
  printf '%s\\n' daemon-spawned >> "$ROOT/events"
  if [ "$_fixture_wait" -gt 0 ]; then
    sleep "$(awk -v ms="$_fixture_wait" 'BEGIN { printf "%.3f", ms / 1000 }')"
    kill -0 "$_fixture_pid" 2>/dev/null || { wait "$_fixture_pid" || :; return 1; }
    if [ -r "/proc/$_fixture_pid/stat" ] && [ "$(awk '{print $3}' "/proc/$_fixture_pid/stat")" = Z ]; then
      wait "$_fixture_pid" || :
      return 1
    fi
  fi
}
fixture_rc_service() {
  [ "$#" -eq 2 ] && [ "$1" = "$SERVICE_NAME" ] && [ "$2" = restart ] || return 94
  printf '%s\\n' rc-service >> "$ROOT/events"
  if [ "$CF_SCENARIO" = restart-failure ]; then
    printf 'failure:%s\\n' "$CF_SCENARIO" >> "$ROOT/events"
    return 25
  fi
  (
    RC_SVCNAME="$SERVICE_NAME"; export RC_SVCNAME
    if ! sh -n "$INIT_FILE"; then echo '[fixture-error] generated OpenRC script did not parse' >&2; exit 95; fi
    . "$INIT_FILE"
    start_pre || exit $?
    printf '%s\\n' start-pre-ok >> "$ROOT/events"
    case "$CF_SCENARIO" in
      exits|running) fixture_start_stop_daemon \${start_stop_daemon_args:-} ;;
      *) return 0 ;;
    esac
  )
}
`;
  const boundariesPath = join(root, 'openrc-fixture.sh');
  writeFileSync(boundariesPath, boundaries);
  const shimPaths = ['rc-update', 'rc-service'].map(name => {
    const path = join(root, 'bin', name);
    const handler = name === 'rc-update' ? 'fixture_rc_update' : 'fixture_rc_service';
    // Use the same PATH-selected sh as the test runner, including a strict dash run.
    writeFileSync(path, `#!/usr/bin/env sh\nset -eu\n. "$ROOT/openrc-fixture.sh"\n${handler} "$@"\n`, { mode: 0o755 });
    return path;
  });
  const script = `${source}
ROOT=${quote(posix(root))}
TMPDIR="$ROOT/temp"; export TMPDIR
INSTALL_DIR="$ROOT/owned 'quoted' install"; STATE_DIR="$INSTALL_DIR/state"; RUNNER_FILE="$INSTALL_DIR/run-agent.sh"
SERVICE_MODE=openrc; SERVICE_NAME=${quote(serviceName)}; BASE_ID=openrc-fixture; INSTANCE_ID=openrc-fixture
ENV_FILE="$ROOT/etc/conf.d/$SERVICE_NAME"; INIT_FILE="$ROOT/etc/init.d/$SERVICE_NAME"
DRY_RUN=0; KEEP_FILES=0; AGENT_USER="$(id -un)"; WORK_BIN="$ROOT/synthetic-agent"
SERVER=https://monitor.example.test; TOKEN=synthetic-token; NODE_NAME=synthetic-node; MODE=websocket
INTERVAL=3; PING_INTERVAL=120; TRAFFIC_RESET_DAY=1
CF_SCENARIO=${quote(scenario)}
export ROOT SERVICE_NAME INIT_FILE CF_SCENARIO
FIXTURE_BIN="$(cd "$ROOT/bin" && pwd)"
export PATH="$FIXTURE_BIN:$PATH"
for fixture_command in rc-service rc-update; do
  [ "$(command -v "$fixture_command")" = "$FIXTURE_BIN/$fixture_command" ] || {
    echo '[fixture-error] service command did not resolve to its isolated shim' >&2
    exit 96
  }
done
ensure_agent_user() { :; }
# Account creation/service-manager registration are external boundaries. Files,
# generated shell code, log contents and the daemon child below remain real.
run() { if [ "$1" = chown ]; then return 0; fi; "$@"; }
cleanup_children() {
  if [ -f "$ROOT/children" ]; then
    while IFS= read -r _fixture_child; do
      case "$_fixture_child" in ''|0|1|*[!0-9]*) continue ;; esac
      if [ -r "/proc/$_fixture_child/cmdline" ] && tr '\\000' '\\n' < "/proc/$_fixture_child/cmdline" | grep -Fq -- "$ROOT/"; then
        kill "$_fixture_child" 2>/dev/null || :
      fi
    done < "$ROOT/children"
    sleep 0.2
  fi
}
trap cleanup_children EXIT
# Calling conditionally also catches a lost error when shell errexit is disabled
# by a legitimate caller. A restart failure must never fall through to Installed.
if install_openrc; then _fixture_status=0; else _fixture_status=$?; fi
exit "$_fixture_status"
`;
  const scriptPath = join(root, 'install-case.sh');
  writeFileSync(scriptPath, script);
  return {
    root,
    log: join(root, 'var/log', `${serviceName}.log`),
    run() {
      for (const path of [scriptPath, boundariesPath, ...shimPaths, join(root, 'synthetic-agent')]) {
        const syntax = spawnSync('sh', ['-n', posix(path)], { cwd: repo, encoding: 'utf8', timeout: 5000, windowsHide: true });
        assert.ifError(syntax.error);
        assert.equal(syntax.status, 0, `fixture must parse before testing installer failures (${path}): ${syntax.stderr}`);
      }
      const started = Date.now();
      const result = spawnSync('sh', [posix(scriptPath)], { cwd: repo, encoding: 'utf8', timeout: 12_000, windowsHide: true });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.doesNotMatch(result.stderr, /Syntax error:|Bad function name|\[fixture-error\]/i);
      const events = existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8') : '';
      assert.match(events, /^rc-update$/m, 'installer must reach the isolated service registration boundary');
      assert.match(events, /^rc-service$/m, 'installer must reach the isolated restart boundary');
      return { ...result, events, elapsedMs: Date.now() - started };
    },
  };
}

test('OpenRC start prepares a private log before a non-root daemon opens it', { skip: !shellAvailable }, t => {
  const item = fixture(t);
  const result = item.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(item.log), 'start_pre left the service log missing');
  assert.equal(readFileSync(item.log, 'utf8'), '');
  if (process.platform !== 'win32') assert.equal(statSync(item.log).mode & 0o777, 0o600);
});

test('OpenRC reinstall preserves existing log bytes and corrects unsafe log permissions', { skip: !shellAvailable }, t => {
  const item = fixture(t);
  writeFileSync(item.log, 'previous synthetic log\n', { mode: 0o666 });
  chmodSync(item.log, 0o666);
  for (let restart = 0; restart < 2; restart++) {
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(item.log, 'utf8'), 'previous synthetic log\n');
  }
  if (process.platform !== 'win32') assert.equal(statSync(item.log).mode & 0o777, 0o600);
});

for (const scenario of ['state-failure', 'log-failure', 'restart-failure']) {
  test(`OpenRC installation does not claim success after ${scenario}`, { skip: !shellAvailable }, t => {
    const item = fixture(t, scenario);
    const result = item.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Installed /);
    assert.match(result.events, new RegExp(`^failure:${scenario}$`, 'm'), 'the requested failure must actually execute');
  });
}

for (const kind of ['symlink', 'hardlink', 'directory', 'ancestor-symlink']) {
  test(`OpenRC rejects a ${kind} log without changing another file`, { skip: !shellAvailable }, t => {
    const item = fixture(t);
    const target = join(item.root, 'unrelated-log');
    writeFileSync(target, 'unrelated sentinel\n', { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(target, item.log, 'file');
    if (kind === 'hardlink') linkSync(target, item.log);
    if (kind === 'directory') mkdirSync(item.log);
    if (kind === 'ancestor-symlink') {
      rmdirSync(join(item.root, 'var/log'));
      mkdirSync(join(item.root, 'linked-logs'));
      symlinkSync(join(item.root, 'linked-logs'), join(item.root, 'var/log'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const result = item.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /Installed /);
    assert.match(result.stderr, kind.includes('symlink') ? /Refusing a linked Agent log path/ : /Refusing a non-regular or hard-linked Agent log/);
    assert.doesNotMatch(result.events, /^start-pre-ok$/m, 'an unsafe log cannot reach the daemon launch stage');
    assert.equal(readFileSync(target, 'utf8'), 'unrelated sentinel\n');
  });
}

test('OpenRC rejects a daemon that exits after the background launch returns', { skip: !shellAvailable }, t => {
  const item = fixture(t, 'exits');
  writeFileSync(item.log, 'earlier synthetic output\n', { mode: 0o600 });
  const result = item.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Installed /);
  assert.match(readFileSync(item.log, 'utf8'), /earlier synthetic output/);
  assert.match(readFileSync(item.log, 'utf8'), /synthetic startup failure/);
  assert.match(result.events, /^daemon-spawned$/m, 'the failed daemon must have been launched');
  assert.ok(result.elapsedMs < 10_000, 'startup confirmation must finish within a bounded interval');
});

test('OpenRC confirms a running daemon and keeps its startup log', { skip: !shellAvailable }, t => {
  const item = fixture(t, 'running');
  const result = item.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Installed /);
  assert.match(readFileSync(item.log, 'utf8'), /synthetic agent running/);
  assert.match(result.events, /^daemon-spawned$/m, 'the successful daemon must have been launched');
  assert.ok(result.elapsedMs < 10_000, 'startup confirmation must finish within a bounded interval');
});
