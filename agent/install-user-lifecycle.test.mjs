import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('./install.sh', import.meta.url), 'utf8').split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const shellAvailable = spawnSync('sh', ['-c', ':'], { windowsHide: true }).status === 0;

function userFixture(t, scenario, diskOptions = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'cf-agent-user-test-'));
  const posix = root.replaceAll('\\', '/');
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(root, 'cron.txt'), '15 * * * * unrelated-job # keep-me\n');
  writeFileSync(path.join(root, 'bin', 'crontab'), '#!/bin/sh\nif [ "$1" = "-l" ]; then cat "$CF_MONITOR_TEST_CRON"; else cp "$1" "$CF_MONITOR_TEST_CRON"; fi\n', { mode: 0o755 });
  const agent = marker => `#!/bin/sh\nprintf '%s\\n' "\${CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES-unset}" "\${CF_MONITOR_DISK_USAGE_FILE-unset}" > "$CF_MONITOR_TEST_DISK_OUTPUT"\nprintf '${marker}|%s\\n' "$CF_MONITOR_TOKEN" > "$CF_MONITOR_TEST_OUTPUT"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n`;
  writeFileSync(path.join(root, 'old-agent'), agent('old'), { mode: 0o755 });
  writeFileSync(path.join(root, 'new-agent'), agent('new'), { mode: 0o755 });
  writeFileSync(path.join(root, 'bad-agent'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const script = `${source}
ROOT=${quote(posix)}
export XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state"
export CF_MONITOR_TEST_CRON="$ROOT/cron.txt" CF_MONITOR_TEST_OUTPUT="$ROOT/running.txt"
export CF_MONITOR_TEST_DISK_OUTPUT="$ROOT/disk-environment.txt"
FIXTURE_BIN="$(cd "$ROOT/bin" && pwd)"
export PATH="$FIXTURE_BIN:$PATH"
[ "$(command -v crontab)" = "$FIXTURE_BIN/crontab" ] || { echo 'Unsafe crontab fixture path' >&2; exit 90; }
TMPDIR="$ROOT/temp"; export TMPDIR; mkdir -p "$TMPDIR"
SERVICE_MODE=user; DRY_RUN=0; YES=1; KEEP_FILES=0; INSTALL_DIR=''; SERVICE_NAME=''; INSTANCE_ID=one
SERVER=https://monitor.example.test; TOKEN=old-token; NODE_NAME=fixture; MODE=websocket
MOUNT_INCLUDE=''; MOUNT_EXCLUDE=''; NIC_INCLUDE=''; NIC_EXCLUDE=''
INTERVAL=3; PING_INTERVAL=120; TRAFFIC_RESET_DAY=1
${diskOptions}
apply_defaults
test_pids=''
cleanup_fixture() {
  for file in "$ROOT"/state/cf-vps-monitor/*/agent.pid; do [ ! -f "$file" ] || test_pids="$test_pids $(cat "$file")"; done
  for candidate in $test_pids; do
    case "$candidate" in ''|0|*[!0-9]*) continue ;; esac
    kill "$candidate" 2>/dev/null || true
  done
  sleep 1
}
trap cleanup_fixture EXIT
wait_marker() {
  count=0
  while [ "$count" -lt 50 ]; do
    if [ -f "$CF_MONITOR_TEST_OUTPUT" ] && [ "$(cat "$CF_MONITOR_TEST_OUTPUT")" = "$1" ]; then return 0; fi
    sleep 0.1; count=$((count + 1))
  done
  return 1
}
WORK_BIN="$ROOT/old-agent"
install_user_mode
old_pid=$(cat "$PID_FILE"); test_pids="$test_pids $old_pid"
wait_marker 'old|old-token'
${scenario}
`;
  const scriptPath = path.join(root, 'case.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('sh', [scriptPath], { encoding: 'utf8', timeout: 40_000, windowsHide: true });
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('cf-agent-user-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return { output: result.stdout, cron: readFileSync(path.join(root, 'cron.txt'), 'utf8'), diskEnvironment: readFileSync(path.join(root, 'disk-environment.txt'), 'utf8') };
}

test('AUD-27 user-mode reinstall replaces the running image and inherited environment', { skip: !shellAvailable }, t => {
  const result = userFixture(t, `
WORK_BIN="$ROOT/new-agent"; TOKEN=new-token
install_user_mode
new_pid=$(cat "$PID_FILE"); test_pids="$test_pids $new_pid"
wait_marker 'new|new-token' || true
if kill -0 "$old_pid" 2>/dev/null; then old_alive=1; else old_alive=0; fi
printf 'RESULT:%s:%s:%s:%s\\n' "$old_alive" "$old_pid" "$new_pid" "$(cat "$CF_MONITOR_TEST_OUTPUT")"
`);
  const match = result.output.match(/RESULT:(\d+):(\d+):(\d+):([^\r\n]+)/);
  assert.ok(match, result.output);
  assert.equal(match[1], '0', 'old process is still alive');
  assert.notEqual(match[2], match[3], 'upgrade retained the old PID');
  assert.equal(match[4], 'new|new-token');
});

test('user-mode reinstall exports and preserves administrator disk options into the actual child', { skip: !shellAvailable }, t => {
  const result = userFixture(t, `
WORK_BIN="$ROOT/new-agent"; TOKEN=new-token
CONTAINER_DISK_TOTAL_SET=0; CONTAINER_DISK_TOTAL_BYTES=0
DISK_USAGE_FILE_SET=0; DISK_USAGE_FILE=''; DISK_USAGE_FILE_PRESENT=0
install_user_mode
test_pids="$test_pids $(cat "$PID_FILE")"
wait_marker 'new|new-token'
`, "CONTAINER_DISK_TOTAL_SET=1; CONTAINER_DISK_TOTAL_BYTES=5024000000; DISK_USAGE_FILE_SET=1; DISK_USAGE_FILE='/run/admin cache/usage.json'");
  assert.equal(result.diskEnvironment, '5024000000\n/run/admin cache/usage.json\n');
});

test('AUD-27 a failed user-mode replacement restores the old running version', { skip: !shellAvailable }, t => {
  const result = userFixture(t, `
WORK_BIN="$ROOT/bad-agent"; TOKEN=new-token
rm -f "$CF_MONITOR_TEST_OUTPUT"
set +e
install_user_mode
upgrade_status=$?
set -e
test_pids="$test_pids $(cat "$PID_FILE" 2>/dev/null || true)"
wait_marker 'old|old-token' || true
restored_pid=$(cat "$PID_FILE")
if kill -0 "$restored_pid" 2>/dev/null; then restored_alive=1; else restored_alive=0; fi
printf 'RESULT:%s:%s:%s\\n' "$upgrade_status" "$restored_alive" "$(cat "$CF_MONITOR_TEST_OUTPUT")"
`);
  const match = result.output.match(/RESULT:(\d+):(\d+):([^\r\n]+)/);
  assert.ok(match, result.output);
  assert.notEqual(match[1], '0', 'failed replacement was reported successful');
  assert.equal(match[2], '1', 'restored process is not running');
  assert.equal(match[3], 'old|old-token');
});

test('AUD-27 generated stop refuses a PID belonging to another executable', { skip: !shellAvailable }, t => {
  const result = userFixture(t, `
CF_MONITOR_TEST_OUTPUT="$ROOT/unrelated.txt" "$ROOT/new-agent" &
foreign_pid=$!; test_pids="$test_pids $foreign_pid"
printf '%s\\n' "$foreign_pid" > "$PID_FILE"
set +e
"$INSTALL_DIR/stop.sh"
stop_status=$?
set -e
sleep 1
if kill -0 "$foreign_pid" 2>/dev/null; then foreign_alive=1; else foreign_alive=0; fi
printf 'RESULT:%s:%s\\n' "$stop_status" "$foreign_alive"
`);
  const match = result.output.match(/RESULT:(\d+):(\d+)/);
  assert.ok(match, result.output);
  assert.notEqual(match[1], '0');
  assert.equal(match[2], '1', 'unrelated fixture process was stopped');
});

for (const keep of [0, 1]) {
  test(`AUD-28 uninstall-all stops both instances and preserves unrelated cron rows (keep-files=${keep})`, { skip: !shellAvailable }, t => {
    const result = userFixture(t, `
first_dir="$INSTALL_DIR"; first_pid="$old_pid"
INSTALL_DIR="$ROOT/custom-two"; SERVICE_NAME=''; INSTANCE_ID=two
apply_defaults
CF_MONITOR_TEST_OUTPUT="$ROOT/second.txt"; export CF_MONITOR_TEST_OUTPUT
WORK_BIN="$ROOT/old-agent"; TOKEN=second-token
install_user_mode
second_dir="$INSTALL_DIR"; second_pid=$(cat "$PID_FILE"); test_pids="$test_pids $second_pid"
printf '0 0 * * * unrelated-similar # cf-vps-monitor:one-other\\n' >> "$CF_MONITOR_TEST_CRON"
mkdir -p "$ROOT/state/cf-vps-monitor/unowned" "$ROOT/unowned"
printf '%s\\n' "$ROOT/unowned" > "$ROOT/state/cf-vps-monitor/unowned/install-dir"
printf 'unrelated' > "$ROOT/unowned/sentinel"
KEEP_FILES=${keep}
uninstall_all_agents
if kill -0 "$first_pid" 2>/dev/null; then first_alive=1; else first_alive=0; fi
if kill -0 "$second_pid" 2>/dev/null; then second_alive=1; else second_alive=0; fi
if [ -d "$first_dir" ] && [ -d "$second_dir" ]; then kept=1; else kept=0; fi
if [ -f "$ROOT/unowned/sentinel" ]; then unowned_kept=1; else unowned_kept=0; fi
printf 'RESULT:%s:%s:%s:%s\\n' "$first_alive" "$second_alive" "$kept" "$unowned_kept"
`);
    const match = result.output.match(/RESULT:(\d+):(\d+):(\d+):(\d+)/);
    assert.ok(match, result.output);
    assert.equal(match[1], '0', 'first instance is still running');
    assert.equal(match[2], '0', 'second instance is still running');
    assert.equal(match[3], String(keep));
    assert.equal(match[4], '1', 'unowned directory was removed');
    assert.doesNotMatch(result.cron, /# cf-vps-monitor:(one|two)\s*$/m);
    assert.match(result.cron, /unrelated-job # keep-me/);
    assert.match(result.cron, /unrelated-similar # cf-vps-monitor:one-other/);
  });
}
