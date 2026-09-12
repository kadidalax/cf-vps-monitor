import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const posix = value => value.replaceAll('\\', '/').replace(/^([A-Z]):\//i, (_, drive) => `/${drive.toLowerCase()}/`);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const service = 'cf-vps-monitor-agent-disk-fixture';
const shellAvailable = spawnSync('sh', ['-c', ':'], { windowsHide: true }).status === 0;
const gitPath = process.platform === 'win32' ? spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)[0] : '';
const bash = process.platform === 'win32' ? join(dirname(dirname(gitPath)), 'bin', 'bash.exe') : 'bash';
const sources = Object.fromEntries(['install.sh', 'install-linux.sh'].map(name => [name,
  readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll('\r\n', '\n')]));

function fixture(t, installer, mode, options = {}) {
  const parentDir = options.native ? '/run/cf-monitor-installer-tests' : join(repo, '.tmp', 'disk-installer-tests');
  mkdirSync(parentDir, { recursive: true });
  const parent = realpathSync(parentDir);
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(dirname(resolved), parent);
    assert.ok(resolved.startsWith(parent + sep));
    rmSync(resolved, { recursive: true, force: true });
  });
  for (const child of ['etc/systemd/system', 'etc/conf.d', 'etc/init.d', 'run', 'var/log', 'bin', 'sbin', 'proc/1', 'temp', 'opt']) {
    mkdirSync(join(root, child), { recursive: true });
  }
  if (!options.inactive) {
    mkdirSync(join(root, mode === 'systemd' ? 'run/systemd/system' : 'run/openrc'), { recursive: true });
    writeFileSync(join(root, 'proc/1/comm'), mode === 'systemd' ? 'systemd\n' : 'init\n');
    if (mode === 'openrc') {
      writeFileSync(join(root, 'run/openrc/softlevel'), 'default\n');
      writeFileSync(join(root, 'sbin/openrc-run'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }
  const installDir = join(root, 'opt', "owned 'quoted' install");
  const envFile = mode === 'openrc' ? join(root, 'etc/conf.d', service) : join(root, 'etc', `${service}.env`);
  const unit = join(root, 'etc/systemd/system', `${service}.service`);
  const init = join(root, 'etc/init.d', service);
  const cacheDir = join(root, 'run/cf-vps-monitor-disk', service);
  const executable = join(root, 'synthetic-agent');
  writeFileSync(executable, `#!/bin/sh
ROOT=${quote(posix(root))}
case "\${1:-}" in
  --disk-usage-check)
    printf '%s\\n' "$@" > "$ROOT/check-args"
    printf '%s\\n' "\${CF_MONITOR_TOKEN-unset}" > "$ROOT/check-token"
    printf '%s\\n' check >> "$ROOT/events"
    exit ${options.needed === false ? 3 : options.checkFailure ? 7 : 0} ;;
  --disk-usage-collector)
    printf '%s\\n' "$@" > "$ROOT/collector-args"
    printf '%s\\n' "\${CF_MONITOR_TOKEN-unset}" > "$ROOT/collector-token"
    exit 0 ;;
  *) printf '%s\\n' "\${CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES-unset}" "\${CF_MONITOR_DISK_USAGE_FILE-unset}" > "$ROOT/agent-env" ;;
esac
`, { mode: 0o755 });
  if (options.oldConfig !== undefined) {
    mkdirSync(join(installDir, 'state'), { recursive: true });
    writeFileSync(join(installDir, '.cf-vps-monitor-owned'),
      `cf-vps-monitor-agent:1\ndisk-fixture\n${mode}\n${service}\n${posix(installDir)}\n${posix(envFile)}\n${posix(join(installDir, 'state'))}\n`);
    writeFileSync(envFile, options.oldConfig);
  }
  const source = sources[installer]
    .replaceAll('/etc/', `${posix(root)}/etc/`)
    .replaceAll('/run/', `${posix(root)}/run/`)
    .replaceAll('/var/log/', `${posix(root)}/var/log/`)
    .replaceAll('/proc/1/', `${posix(root)}/proc/1/`)
    .replaceAll('/sbin/openrc-run', `${posix(root)}/sbin/openrc-run`);
  const definitions = source.split(installer === 'install.sh'
    ? /^while \[ "\$#" -gt 0 \]; do/m : /^while \[\[ \$# -gt 0 \]\]; do/m)[0];
  const install = installer === 'install.sh' ? `install_${mode}`
    : source.slice(source.lastIndexOf('\nif ! is_macos; then\n', source.indexOf('\nrun mkdir -p "$INSTALL_DIR"')));
  const script = `${definitions}
ROOT=${quote(posix(root))}; export ROOT
TMPDIR="$ROOT/temp"; export TMPDIR
INSTALL_DIR=${quote(posix(installDir))}; STATE_DIR="$INSTALL_DIR/state"; RUNNER_FILE="$INSTALL_DIR/run-agent.sh"
BASE_ID=disk-fixture; INSTANCE_ID=disk-fixture; SERVICE_NAME=${quote(service)}; SERVICE_MODE=${quote(mode)}
OS_NAME=linux; PLATFORM_OS=linux; AGENT_USER=fixture-agent
ENV_FILE=${quote(posix(envFile))}; UNIT_FILE=${quote(posix(unit))}; INIT_FILE=${quote(posix(init))}
PLIST_FILE="$ROOT/unused.plist"; WORK_BIN=${quote(posix(executable))}
SERVER=https://monitor.example.test; TOKEN=synthetic-token; NODE_NAME=fixture; MODE=websocket
CF_MONITOR_TOKEN=synthetic-inherited-secret; export CF_MONITOR_TOKEN
MOUNT_INCLUDE='/'; MOUNT_EXCLUDE='/data space'; DRY_RUN=0; KEEP_FILES=0
OPENRC_STOP_FAIL=0; OPENRC_QUERY_FAIL=0; OPENRC_DELETE_FAIL=0
${options.settings ?? ''}
ensure_agent_user() { :; }
# Model privileged metadata only. Native tests below exercise the actual checks.
id() { if [ "$1" = -u ]; then printf '%s\\n' ${options.nonroot ? '1000' : '0'}; else command id "$@"; fi; }
stat() {
  case "$*" in
    *'%u %a'*)
      case "$*" in *'/owned '\\''quoted'*) printf '%s\\n' '${options.unsafe ? '1000 775' : '0 755'}' ;; *) printf '%s\\n' '0 755' ;; esac ;;
    *'%u %a %h'*) printf '%s\\n' '0 644 1' ;;
    *) command stat "$@" ;;
  esac
}
${options.native ? 'unset -f id stat' : ''}
eerror() { printf '%s\\n' "$*" >&2; }
checkpath() {
  _fixture_kind="$1"; shift
  while [ "$#" -gt 1 ]; do shift 2; done
  case "$1" in "$ROOT"/*) ;; *) return 90 ;; esac
  case "$_fixture_kind" in -d) mkdir -p "$1" ;; -f) [ -e "$1" ] || : > "$1" ;; *) return 91 ;; esac
}

run() {
  case "$1" in
    chown) return 0 ;;
    systemctl|rc-service|rc-update)
      printf '%s\\n' "$*" >> "$ROOT/events"
      case "$*" in
        "rc-update show default")
          [ "$OPENRC_QUERY_FAIL" = 0 ] || return 20
          if [ -f "$ROOT/disk-registered" ]; then printf '%s | default\\n' "$SERVICE_NAME-disk-usage"; fi
          return 0 ;;
        "rc-update add $SERVICE_NAME-disk-usage default") : > "$ROOT/disk-registered" ;;
        "rc-update del $SERVICE_NAME-disk-usage default")
          [ "$OPENRC_DELETE_FAIL" = 0 ] || return 21
          [ -f "$ROOT/disk-registered" ] || return 1
          rm "$ROOT/disk-registered" ;;
        "rc-service $SERVICE_NAME-disk-usage stop") [ "$OPENRC_STOP_FAIL" = 0 ] || return 22 ;;
      esac
      case "$*" in
        *disk-usage*stop*|*stop*disk-usage*|*disable*disk-usage*)
          if [ -f "$INSTALL_DIR/cf-vps-monitor-agent" ]; then cksum "$INSTALL_DIR/cf-vps-monitor-agent" >> "$ROOT/stopped-binary"; fi ;;
        *disk-usage*restart*|*restart*disk-usage*)
          [ ${options.startFailure ? '1' : '0'} = 0 ] || return 19
          if [ "$SERVICE_MODE" = openrc ]; then
            (unset CF_MONITOR_TOKEN; RC_SVCNAME="$SERVICE_NAME-disk-usage"; . "$INIT_FILE-disk-usage"; start_pre; eval '\"$command\"' "$command_args") || return $?
          fi ;;
        "rc-service $SERVICE_NAME restart")
          (unset CF_MONITOR_TOKEN; RC_SVCNAME="$SERVICE_NAME"; . "$ENV_FILE"; . "$INIT_FILE"; start_pre; "$command") || return $? ;;
      esac
      return 0 ;;
    *) "$@" ;;
  esac
}
${options.before ?? ''}
${install}
${options.after ?? ''}
`;
  const scriptPath = join(root, 'install-case.sh');
  writeFileSync(scriptPath, script);
  return {
    root, installDir, envFile, unit, init, cacheDir, scriptPath,
    run() {
      const shell = installer === 'install.sh' ? 'sh' : bash;
      const syntax = spawnSync(shell, ['-n', posix(scriptPath)], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      assert.ifError(syntax.error);
      assert.equal(syntax.status, 0, syntax.stderr);
      const result = spawnSync(shell, [posix(scriptPath)], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 25000 });
      assert.ifError(result.error);
      assert.doesNotMatch(result.stderr, /Syntax error:|Bad function name/i);
      return result;
    },
  };
}

// Consumes the generated EnvironmentFile grammar, never the installer encoder.
function environment(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => {
    const split = line.indexOf('=');
    let value = line.slice(split + 1);
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\([\\"$`])/g, '$1');
    else if (value.startsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'");
    return [line.slice(0, split), value];
  }));
}

for (const [installer, mode] of [['install.sh', 'openrc'], ['install.sh', 'systemd'], ['install-linux.sh', 'systemd']]) {
  test(`${installer} ${mode} preserves literal disk options without executing old configuration`, { skip: !shellAvailable }, t => {
    const item = fixture(t, installer, mode, {
      oldConfig: "export CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES=5024000000\nCF_MONITOR_DISK_USAGE_FILE='/run/admin cache/usage.json'\nprintf bad > \"$ROOT/old-config-executed\"\n",
    });
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const values = environment(item.envFile);
    assert.equal(values.CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES, '5024000000');
    assert.equal(values.CF_MONITOR_DISK_USAGE_FILE, '/run/admin cache/usage.json');
    assert.equal(existsSync(join(item.root, 'old-config-executed')), false);
    if (mode === 'openrc') assert.equal(readFileSync(join(item.root, 'agent-env'), 'utf8'), '5024000000\n/run/admin cache/usage.json\n');
  });

  test(`${installer} ${mode} installs the selected root collector and passes selectors`, { skip: !shellAvailable }, t => {
    const item = fixture(t, installer, mode);
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const helper = mode === 'systemd' ? item.unit.replace(/\.service$/, '-disk-usage.service') : `${item.init}-disk-usage`;
    assert.ok(existsSync(helper), result.stdout + result.stderr);
    const values = environment(item.envFile);
    assert.equal(values.CF_MONITOR_DISK_USAGE_FILE, `${posix(item.cacheDir)}/usage.json`);
    assert.equal(readFileSync(join(item.root, 'check-args'), 'utf8'), '--disk-usage-check\n--mount-include\n/\n--mount-exclude\n/data space\n--container-disk-total-bytes\n0\n');
    assert.equal(readFileSync(join(item.root, 'check-token'), 'utf8'), 'unset\n');
    if (mode === 'openrc') {
      assert.equal(readFileSync(join(item.root, 'collector-args'), 'utf8'), `--disk-usage-collector\n${service}\n--mount-include\n/\n--mount-exclude\n/data space\n--container-disk-total-bytes\n0\n`);
      assert.equal(readFileSync(join(item.root, 'collector-token'), 'utf8'), 'unset\n');
      assert.equal(readFileSync(join(item.root, 'agent-env'), 'utf8'), `0\n${posix(item.cacheDir)}/usage.json\n`);
    }
    const events = readFileSync(join(item.root, 'events'), 'utf8');
    assert.match(events, mode === 'openrc' ? /rc-service .*disk-usage restart/ : /systemctl restart .*disk-usage/);
    assert.doesNotMatch(events, /cron|sudo/);
  });
}


for (const [installer, mode] of [['install.sh', 'openrc'], ['install.sh', 'systemd'], ['install-linux.sh', 'systemd']]) {
  test(`${installer} ${mode} stops the old collector before replacing its executable`, { skip: !shellAvailable }, t => {
    const item = fixture(t, installer, mode, {
      oldConfig: "CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES='5024000000'\n",
      before: `
printf '#!/bin/sh\\nexit 3\\n' > "$INSTALL_DIR/cf-vps-monitor-agent"
cksum "$INSTALL_DIR/cf-vps-monitor-agent" > "$ROOT/old-binary"
if [ "$SERVICE_MODE" = openrc ]; then old_helper="$INIT_FILE-disk-usage"; else old_helper="\${UNIT_FILE%.service}-disk-usage.service"; fi
printf '%s\\n' '# cf-vps-monitor-disk-usage:1' "# service: $SERVICE_NAME" "# install: $INSTALL_DIR" > "$old_helper"
`,
    });
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(item.root, 'stopped-binary'), 'utf8'), readFileSync(join(item.root, 'old-binary'), 'utf8'));
    const events = readFileSync(join(item.root, 'events'), 'utf8');
    assert.ok(events.indexOf('disk-usage') < events.indexOf('\ncheck\n'), events);
    assert.equal(environment(item.envFile).CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES, '5024000000');
  });

  for (const keepFiles of [false, true]) {
    test(`${installer} ${mode} uninstall${keepFiles ? ' keep-files' : ''} cleans only selected collector files`, { skip: !shellAvailable }, t => {
      const item = fixture(t, installer, mode, {
        after: `
mkdir -p "$DISK_CACHE_DIR" "$DISK_CACHE_DIR-other"
for name in usage.json scan.lock .usage-0123456789abcdef01234567.tmp .usage-zzzzzzzzzzzzzzzzzzzzzzzz.tmp keep-me; do
  printf sentinel > "$DISK_CACHE_DIR/$name"
done
printf other > "$DISK_CACHE_DIR-other/usage.json"
KEEP_FILES=${keepFiles ? '1' : '0'}
agent_remove_owned_system
`,
      });
      const result = item.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const file of ['usage.json', 'scan.lock', '.usage-0123456789abcdef01234567.tmp']) assert.equal(existsSync(join(item.cacheDir, file)), false, file);
      assert.equal(readFileSync(join(item.cacheDir, 'keep-me'), 'utf8'), 'sentinel');
      assert.equal(readFileSync(join(item.cacheDir, '.usage-zzzzzzzzzzzzzzzzzzzzzzzz.tmp'), 'utf8'), 'sentinel');
      assert.equal(readFileSync(`${item.cacheDir}-other/usage.json`, 'utf8'), 'other');
      assert.equal(existsSync(item.installDir), keepFiles);
      const helper = mode === 'systemd' ? item.unit.replace(/\.service$/, '-disk-usage.service') : `${item.init}-disk-usage`;
      assert.equal(existsSync(helper), false);
      const events = readFileSync(join(item.root, 'events'), 'utf8');
      const lastStart = events.lastIndexOf('disk-usage restart');
      assert.ok(mode === 'systemd' ? /systemctl disable --now .*disk-usage/.test(events) : events.lastIndexOf('disk-usage stop') > lastStart, events);
      assert.doesNotMatch(events, /disk-fixture-other/);
    });
  }
}

for (const scenario of [
  { name: 'unsupported scope', needed: false },
  { name: 'nonroot install', nonroot: true },
  { name: 'writable binary parent', unsafe: true },
  { name: 'inactive service manager', inactive: true },
  { name: 'explicit empty cache', settings: "DISK_USAGE_FILE_SET=1; DISK_USAGE_FILE=''" },
]) {
  test(`disk collector is not installed for ${scenario.name}`, { skip: !shellAvailable }, t => {
    const item = fixture(t, 'install.sh', 'systemd', scenario);
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(item.unit.replace(/\.service$/, '-disk-usage.service')), false);
    if (scenario.needed !== false) assert.equal(existsSync(join(item.root, 'check-args')), false, 'ineligible installs must not run the binary as root');
  });
}

for (const scenario of [
  { name: 'retry after failed startup', startFailure: true, after: 'install_openrc; agent_remove_owned_system' },
  { name: 'switch to an external cache and retry', after: "DISK_USAGE_FILE_SET=1; DISK_USAGE_FILE='/run/admin/usage.json'; install_openrc; install_openrc; agent_remove_owned_system" },
  { name: 'switch to a disabled cache and retry', after: "DISK_USAGE_FILE_SET=1; DISK_USAGE_FILE=''; install_openrc; install_openrc; agent_remove_owned_system" },
  { name: 'uninstall an already disabled collector', after: 'agent_stop_disk_collector; agent_remove_owned_system' },
]) {
  test(`OpenRC permits ${scenario.name} when its default registration is absent`, { skip: !shellAvailable }, t => {
    const item = fixture(t, 'install.sh', 'openrc', scenario);
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(`${item.init}-disk-usage`), false);
    assert.equal(existsSync(item.installDir), false);
    assert.equal(existsSync(join(item.root, 'disk-registered')), false);
  });
}

for (const failure of ['STOP', 'QUERY', 'DELETE']) {
  test(`OpenRC keeps a real collector ${failure.toLowerCase()} failure visible`, { skip: !shellAvailable }, t => {
    const item = fixture(t, 'install.sh', 'openrc', {
      after: `OPENRC_${failure}_FAIL=1\nif agent_stop_disk_collector; then exit 97; fi\nprintf retained > "$ROOT/stop-failed"`,
    });
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(item.root, 'stop-failed'), 'utf8'), 'retained');
    assert.equal(existsSync(join(item.root, 'disk-registered')), true);
  });
}

for (const [installer, mode] of [['install.sh', 'systemd'], ['install-linux.sh', 'systemd'], ['install.sh', 'openrc']]) {
  test(`${installer} ${mode} pins the main default selector to the enabled root collector scope`, { skip: !shellAvailable }, t => {
    const item = fixture(t, installer, mode, { settings: "MOUNT_INCLUDE=''" });
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(environment(item.envFile).CF_MONITOR_MOUNT_INCLUDE, '/');
    assert.equal(environment(item.envFile).CF_MONITOR_MOUNT_EXCLUDE, '/data space');
    if (mode === 'systemd') {
      const unit = readFileSync(item.unit, 'utf8');
      assert.match(unit, /ProtectSystem=strict/);
      assert.match(unit, /PrivateTmp=true/);
      assert.match(unit, /ReadWritePaths=/);
      assert.match(unit, /CapabilityBoundingSet=CAP_NET_RAW/);
    }
  });
  for (const include of ['', '/data', '/,/data']) {
    test(`${installer} ${mode} preserves selector ${JSON.stringify(include)} without a needed collector`, { skip: !shellAvailable }, t => {
      const item = fixture(t, installer, mode, { settings: `MOUNT_INCLUDE=${quote(include)}`, needed: false });
      const result = item.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(environment(item.envFile).CF_MONITOR_MOUNT_INCLUDE, include);
      assert.equal(environment(item.envFile).CF_MONITOR_MOUNT_EXCLUDE, '/data space');
    });
  }
}

test('explicit zero and empty cache replace preserved nonsecret values', { skip: !shellAvailable }, t => {
  const item = fixture(t, 'install.sh', 'openrc', {
    oldConfig: "CF_MONITOR_CONTAINER_DISK_TOTAL_BYTES='5024000000'\nCF_MONITOR_DISK_USAGE_FILE='/run/admin/usage.json'\n",
    settings: "CONTAINER_DISK_TOTAL_SET=1; CONTAINER_DISK_TOTAL_BYTES=0; DISK_USAGE_FILE_SET=1; DISK_USAGE_FILE=''",
  });
  const result = item.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(item.root, 'agent-env'), 'utf8'), '0\n\n');
  assert.equal(existsSync(`${item.init}-disk-usage`), false);
});

for (const mode of ['systemd', 'openrc']) {
  test(`${mode} collector startup failure is visible while main Agent remains installed`, { skip: !shellAvailable }, t => {
    const item = fixture(t, 'install.sh', mode, { startFailure: true });
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Disk collector failed to start/);
    assert.ok(existsSync(join(item.installDir, 'cf-vps-monitor-agent')));
    const events = readFileSync(join(item.root, 'events'), 'utf8');
    assert.match(events, mode === 'systemd' ? /disable --now .*disk-usage/ : /disk-usage stop/);
  });
}

const nativeRoot = process.platform === 'linux' && process.getuid?.() === 0;
test('native ordinary user can read the cache but cannot replace collector binary, service or cache', {
  skip: nativeRoot ? false : 'requires native Linux root; MSYS cannot validate owner/mode access',
}, t => {
  const uid = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' });
  const gid = spawnSync('id', ['-g', 'nobody'], { encoding: 'utf8' });
  assert.equal(uid.status, 0, uid.stderr);
  assert.equal(gid.status, 0, gid.stderr);
  const item = fixture(t, 'install.sh', 'openrc', { native: true });
  chmodSync(item.root, 0o755);
  const result = item.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(`${item.init}-disk-usage`), result.stderr);
  mkdirSync(item.cacheDir, { recursive: true, mode: 0o755 });
  writeFileSync(join(item.cacheDir, 'usage.json'), '{"used_bytes":8388608}\n', { mode: 0o644 });
  const paths = [join(item.installDir, 'cf-vps-monitor-agent'), `${item.init}-disk-usage`, join(item.cacheDir, 'usage.json')];
  for (const path of paths) {
    assert.equal(statSync(path).uid, 0);
    const access = spawnSync('sh', ['-c', 'test -r "$1" && test ! -w "$1" && test ! -w "$(dirname "$1")"', 'check-access', path], {
      encoding: 'utf8', uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()),
    });
    assert.equal(access.status, 0, `${path}: ${access.stderr}`);
  }
});

test('a same-name unowned companion is not changed or stopped on install or uninstall', { skip: !shellAvailable }, t => {
  const item = fixture(t, 'install.sh', 'systemd', {
    before: 'printf unrelated > "${UNIT_FILE%.service}-disk-usage.service"',
    after: 'agent_remove_owned_system',
  });
  const result = item.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(item.unit.replace(/\.service$/, '-disk-usage.service'), 'utf8'), 'unrelated');
  assert.equal(existsSync(join(item.root, 'check-args')), false);
  assert.doesNotMatch(readFileSync(join(item.root, 'events'), 'utf8'), /disk-usage/);
});

// Parse the service manager's command grammar, then execute the generated command.
function systemdWords(value) {
  const result = [];
  let word = '', quoted = '', started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\') { word += value[++index]; started = true; }
    else if (quoted) { if (char === quoted) quoted = ''; else word += char; }
    else if (char === '"' || char === "'") { quoted = char; started = true; }
    else if (/\s/.test(char)) { if (started) { result.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  assert.equal(quoted, '');
  if (started) result.push(word);
  return result.map(word => word.replaceAll('%%', '%'));
}

for (const installer of ['install.sh', 'install-linux.sh']) {
  test(`${installer} generated systemd commands run with separate Agent and collector environments`, { skip: !shellAvailable }, t => {
    const item = fixture(t, installer, 'systemd');
    const result = item.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const collector of [false, true]) {
      const path = collector ? item.unit.replace(/\.service$/, '-disk-usage.service') : item.unit;
      const settings = Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(line => /^[A-Z]/.test(line) && line.includes('=')).map(line => {
        const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
      }));
      assert.equal(settings.User, collector ? 'root' : installer === 'install.sh' ? 'fixture-agent' : 'cf-vps-monitor-agent');
      assert.equal(settings.NoNewPrivileges, 'true');
      if (collector) {
        assert.equal(settings.EnvironmentFile, undefined);
        for (const field of ['ProtectHome', 'ProtectSystem', 'PrivateTmp']) assert.equal(settings[field], undefined, 'the scanner must see the real root tree');
      } else {
        assert.equal(settings.ProtectHome, 'true');
        assert.equal(settings.CapabilityBoundingSet, 'CAP_NET_RAW');
      }
      const [executable, ...args] = systemdWords(settings.ExecStart);
      assert.equal(executable, ':/bin/sh');
      const child = spawnSync('sh', args, {
        encoding: 'utf8', windowsHide: true, timeout: 5000,
        env: { PATH: process.env.PATH, ...(collector ? {} : environment(item.envFile)) },
      });
      assert.equal(child.status, 0, child.stderr);
    }
    assert.equal(readFileSync(join(item.root, 'agent-env'), 'utf8'), `0\n${posix(item.cacheDir)}/usage.json\n`);
    assert.equal(readFileSync(join(item.root, 'collector-token'), 'utf8'), 'unset\n');
    assert.equal(readFileSync(join(item.root, 'collector-args'), 'utf8'), `--disk-usage-collector\n${service}\n--mount-include\n/\n--mount-exclude\n/data space\n--container-disk-total-bytes\n0\n`);
  });
}

test('native a writable custom directory disables only the root companion without changing its permissions', {
  skip: nativeRoot ? false : 'requires native Linux root; MSYS cannot validate owner/mode access',
}, t => {
  const item = fixture(t, 'install.sh', 'openrc', { native: true });
  chmodSync(item.root, 0o755);
  mkdirSync(item.installDir);
  chmodSync(item.installDir, 0o777);
  const result = item.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(item.installDir, 'cf-vps-monitor-agent')));
  assert.equal(existsSync(`${item.init}-disk-usage`), false);
  assert.equal(statSync(item.installDir).mode & 0o777, 0o777);
  assert.match(result.stderr, /root-owned and not writable/);
});

for (const installer of ['install.sh', 'install-linux.sh']) {
  test(`${installer} CLI parses explicit disk overrides as literal arguments and rejects invalid values`, { skip: !shellAvailable }, t => {
    const item = fixture(t, installer, 'systemd');
    const source = sources[installer];
    const parserStart = source.search(installer === 'install.sh' ? /^while \[ "\$#" -gt 0 \]; do/m : /^while \[\[ \$# -gt 0 \]\]; do/m);
    assert.ok(parserStart > 0);
    const parserEnd = source.indexOf('\nset_release_base', parserStart);
    assert.ok(parserEnd > parserStart);
    const script = `${source.slice(0, parserStart)}
ENV_FILE=''; RUNNER_FILE=${quote(posix(join(item.root, 'no-old-config')))}
if [ -n "\${CF_INSTALLER_FIXTURE_NEWLINE:-}" ]; then set -- --disk-usage-file "$CF_INSTALLER_FIXTURE_NEWLINE"; fi
${source.slice(parserStart, parserEnd)}
agent_load_disk_options || exit 1
printf '%s\\n' "$CONTAINER_DISK_TOTAL_BYTES" "$CONTAINER_DISK_TOTAL_SET" "$DISK_USAGE_FILE" "$DISK_USAGE_FILE_SET"
`;
    const path = join(item.root, 'parse-cli.sh');
    writeFileSync(path, script);
    const shell = installer === 'install.sh' ? 'sh' : bash;
    const literalPath = "/run/admin 'quoted' $literal/usage.json";
    for (const [args, expected] of [
      [['--container-disk-total-bytes', '5024000000', '--disk-usage-file', literalPath], `5024000000\n1\n${literalPath}\n1\n`],
      [['--container-disk-total-bytes', '0', '--disk-usage-file', ''], '0\n1\n\n1\n'],
    ]) {
      const result = spawnSync(shell, [posix(path), ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, expected);
    }
    for (const args of [
      ['--container-disk-total-bytes', '-1'],
      ['--container-disk-total-bytes', '1000000000000001'],
      ['--container-disk-total-bytes', '1.5'],
      ['--disk-usage-file', 'relative/usage.json'],
      ['--disk-usage-file', '/run/cache\nextra'],
    ]) {
      // Win32/MSYS argv splits a literal LF; construct that one argument in sh.
      const newline = args[1].includes('\n');
      const result = spawnSync(shell, [posix(path), ...(newline ? [] : args)], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        env: { ...process.env, CF_INSTALLER_FIXTURE_NEWLINE: newline ? args[1] : '' },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be an integer|must be empty or an absolute path/);
    }
  });
}
