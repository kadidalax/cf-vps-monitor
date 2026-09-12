import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtureParent = join(repo, 'worker', '.tmp', 'reaudit-agent-installers');
const isWindows = process.platform === 'win32';

function fixture(t) {
  mkdirSync(fixtureParent, { recursive: true });
  const parent = realpathSync(fixtureParent);
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.ok(resolved.startsWith(parent + sep), 'only remove this test\'s own fixture');
    assert.equal(dirname(resolved), parent, 'cleanup cannot cross a fixture boundary');
    rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function bashExecutable() {
  if (!isWindows) return 'bash';
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(git.error);
  assert.equal(git.status, 0, 'Git for Windows provides the existing Bash test runtime');
  return join(dirname(dirname(git.stdout.trim().split(/\r?\n/)[0])), 'bin', 'bash.exe');
}

function posix(value) {
  return value.replaceAll('\\', '/');
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function generatedServiceFixture(t, scriptName, mode, installDir) {
  const root = fixture(t);
  const source = readFileSync(join(repo, 'agent', scriptName), 'utf8').replaceAll('\r\n', '\n');
  const definitions = source.split(scriptName === 'install.sh'
    ? /^while \[ "\$#" -gt 0 \]; do/m : /^while \[\[ \$# -gt 0 \]\]; do/m)[0];
  let generate;
  if (scriptName === 'install.sh') {
    generate = { systemd: 'install_systemd', launchctl: 'install_launchctl', openrc: 'install_openrc', user: 'install_user_autostart' }[mode];
  } else {
    const start = source.indexOf('reject_env_value() {');
    assert.ok(start > 0, 'the legacy generation stage must be available');
    generate = source.slice(start);
  }
  const setup = `${definitions}
ROOT=${shellQuote(posix(root))}
export TMPDIR="$ROOT" XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state"
INSTALL_DIR=${shellQuote(installDir)}
STATE_DIR="$INSTALL_DIR/state"; RUNNER_FILE="$INSTALL_DIR/run-agent.sh"
BASE_ID=fixture; INSTANCE_ID=fixture; SERVICE_NAME=cf-vps-monitor-fixture; SERVICE_MODE=${shellQuote(mode)}
PLATFORM_OS=${shellQuote(mode === 'launchctl' ? 'darwin' : 'linux')}
ENV_FILE="$ROOT/fixture.env"; UNIT_FILE="$ROOT/resource.service"; INIT_FILE="$ROOT/resource.init"; PLIST_FILE="$ROOT/resource.plist"
[ "$SERVICE_MODE" != launchctl ] || ENV_FILE=''
DRY_RUN=0; KEEP_FILES=0; AGENT_USER=fixture; WORK_BIN="$ROOT/never-executed"
SERVER=https://monitor.example.test; TOKEN=synthetic-token; NODE_NAME=synthetic-node; MODE=websocket
INTERVAL=3; PING_INTERVAL=120; TRAFFIC_RESET_DAY=1
run() { :; }
ensure_agent_user() { :; }
copy_binary_to() { :; }
write_file() {
  case "$1" in
    *.service) printf '%s\\n' "$3" > "$ROOT/generated.service" ;;
    *.plist) printf '%s\\n' "$3" > "$ROOT/generated.plist" ;;
    *.init) printf '%s\\n' "$3" > "$ROOT/generated.init" ;;
    *.env) printf '%s\\n' "$3" > "$ROOT/generated.env" ;;
  esac
}
crontab() {
  if [ "$1" = -l ]; then printf '15 * * * * unrelated-job # keep-me\\n'; else cp "$1" "$ROOT/generated.cron"; fi
}
launchctl() { :; }
agent_assert_instance 0
${generate}
`;
  const script = join(root, 'generate.sh');
  writeFileSync(script, setup);
  const result = spawnSync(scriptName === 'install.sh' ? 'sh' : bashExecutable(), [posix(script)], {
    cwd: repo, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.ifError(result.error);
  return { root, result };
}

// Model the documented consumers, not an encoder's implementation. systemd's
// single-path settings are raw specifier-expanded strings; ExecStart is tokenized.
function systemdSpecifiers(value) {
  return value.replace(/%%|%./g, token => token === '%%' ? '%' : '[unexpected specifier]');
}

function systemdWords(value, exec = false) {
  const words = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') {
      const next = value[++i];
      assert.notEqual(next, undefined, 'trailing escape cannot continue another directive');
      word += next === 't' && exec ? '\t' : next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += char; started = true; }
  }
  assert.equal(quote, '', 'systemd command quotes must balance');
  if (started) words.push(word);
  return words.map(systemdSpecifiers);
}

function systemdExecution(value) {
  const words = systemdWords(value, true);
  const noExpansion = words[0].startsWith(':');
  const executable = noExpansion ? words[0].slice(1) : words[0];
  const args = [executable, ...words.slice(1)];
  // exec-invoke.c resolves command->path before replace_env_argv. Dollars in the
  // executable filename are literal; only argv is subject to environment expansion.
  return { executable, args: noExpansion ? args : args.map(word => word
    .replace(/\$\$|\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z_0-9]*$/g,
      token => token === '$$' ? '$' : '[unexpected variable]')) };
}

function cronCommand(value) {
  let command = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && i + 1 < value.length) {
      const next = value[++i];
      command += next === '%' ? '%' : '\\' + next;
    } else if (char === '%') break;
    else command += char;
  }
  return command;
}

const specialInstallDir = '/srv/cf-agent/custom space & <tag> "double" \'single\' 中文 50% $CF_AGENT_LITERAL ${CF_AGENT_LITERAL} \\tail';

test('R-A06 systemd generated paths decode without splitting or expansion', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) {
    await t.test(script, t => {
      const { root, result } = generatedServiceFixture(t, script, 'systemd', specialInstallDir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const settings = Object.fromEntries(readFileSync(join(root, 'generated.service'), 'utf8').split('\n')
        .filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      const execution = systemdExecution(settings.ExecStart);
      assert.doesNotMatch(execution.executable, /[\x00-\x1f\x7f'"\\*?\[\]]/,
        'systemd string_is_safe(flags=0) rejects these characters in the executable, even after correct unquoting');
      assert.equal(execution.executable, '/bin/sh');
      assert.equal(execution.args[1], '-c');
      // POSIX shells such as dash prohibit redefining the special builtin exec.
      // Replace only the command name; exercise the generated quoting unchanged.
      assert.match(execution.args[2], /^exec\s/);
      const captureCommand = execution.args[2].replace(/^exec(?=\s)/, 'capture_agent_argv');
      const called = spawnSync('sh', ['-c',
        'capture_agent_argv() { printf "%s\\n" "$#" "$@"; }\n' + captureCommand, ...execution.args.slice(3)], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        env: { ...process.env, CF_AGENT_LITERAL: 'unexpected expansion' },
      });
      assert.equal(called.status, 0, called.stderr);
      assert.deepEqual(called.stdout.trimEnd().split('\n'), ['7', specialInstallDir + '/cf-vps-monitor-agent',
        '--interval', '3', '--ping-interval', '120', '--traffic-reset-day', '1']);
      assert.equal(systemdSpecifiers(settings.WorkingDirectory).replace(/\/$/, ''), specialInstallDir);
      assert.deepEqual(systemdWords(settings.ReadWritePaths), [specialInstallDir + '/state']);
      assert.equal(systemdSpecifiers(settings.EnvironmentFile), posix(join(root, 'fixture.env')));
      const environment = spawnSync('sh', ['-c', '. "$1"; printf "%s\\n" "$CF_MONITOR_TRAFFIC_STATE_FILE"',
        'fixture', posix(join(root, 'generated.env'))], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        env: { ...process.env, CF_AGENT_LITERAL: 'unexpected expansion' },
      });
      assert.equal(environment.status, 0, environment.stderr);
      assert.equal(environment.stdout.trimEnd(), specialInstallDir + '/state/traffic-state.json');
    });
  }
});

test('R-A06 launchd XML retains special paths', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) {
    await t.test(script, t => {
      const { root, result } = generatedServiceFixture(t, script, 'launchctl', specialInstallDir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const parsed = spawnSync('python', ['-X', 'utf8', '-c',
        'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', join(root, 'generated.plist')],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.equal(parsed.status, 0, `generated plist is not valid XML: ${parsed.stderr}`);
      const value = JSON.parse(parsed.stdout);
      assert.deepEqual(value.ProgramArguments, [specialInstallDir + '/run-agent.sh']);
      assert.equal(value.WorkingDirectory, specialInstallDir);
    });
  }
});

test('R-A06 cron reconstructs one literal executable after percent processing', t => {
  const { root, result } = generatedServiceFixture(t, 'install.sh', 'user', specialInstallDir + '\\%end');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const row = readFileSync(join(root, 'generated.cron'), 'utf8').split('\n').find(line => line.startsWith('@reboot '));
  assert.ok(row);
  const command = cronCommand(row.slice('@reboot '.length));
  const checked = spawnSync('sh', ['-c', `set -- ${command}\nprintf '%s\\n' "$#" "$1"`], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, CF_AGENT_LITERAL: 'unexpected expansion' },
  });
  assert.equal(checked.status, 0, `generated cron command failed parsing: ${checked.stderr}`);
  assert.equal(checked.stdout.trimEnd(), '1\n' + specialInstallDir + '\\%end/start.sh');
});

test('R-A06 OpenRC evaluates generated paths as literals', t => {
  const { root, result } = generatedServiceFixture(t, 'install.sh', 'openrc', specialInstallDir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const checked = spawnSync('sh', ['-c', '. "$1"; printf "%s\\n" "$command" "$directory"', 'fixture', posix(join(root, 'generated.init'))], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, CF_AGENT_LITERAL: 'unexpected expansion', RC_SVCNAME: 'fixture' },
  });
  assert.equal(checked.status, 0, `generated OpenRC script cannot parse: ${checked.stderr}`);
  assert.equal(checked.stdout.trimEnd(), specialInstallDir + '/cf-vps-monitor-agent\n' + specialInstallDir);
});

function unixOwnedSystemFixture(t, scriptName, mode, serviceName = 'cf-vps-monitor-agent-fixture', keepFiles = false, options = {}) {
  const root = fixture(t);
  for (const directory of ['systemd', 'init', 'launchd', 'env']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'synthetic-binary'), 'synthetic fixture, never executed\n');
  writeFileSync(join(root, 'plist.py'), 'import plistlib,sys\nprint(plistlib.load(open(sys.argv[-1], "rb"))["WorkingDirectory"])\n');
  const installDirectory = options.defaultDirectory ? join(root, 'default-agents', 'fixture') : join(root, "owned space 'quote' 50% 中文");
  if (options.unrelated) {
    const unrelated = join(root, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'sentinel'), 'unrelated content');
    if (mode === 'systemd') writeFileSync(join(root, 'systemd', 'cf-vps-monitor-agent-foreign.service'),
      `Description=Other application\nWorkingDirectory=${posix(unrelated)}\nExecStart=/bin/echo other\n`);
    if (mode === 'openrc') writeFileSync(join(root, 'init', 'cf-vps-monitor-agent-foreign'),
      `name="Other application"\ndirectory=${shellQuote(posix(unrelated))}\ncommand=/bin/echo\n`);
    if (mode === 'launchctl') writeFileSync(join(root, 'launchd', 'cf-vps-monitor-agent-foreign.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>WorkingDirectory</key><string>${posix(unrelated)}</string></dict></plist>`);
  }
  const source = readFileSync(join(repo, 'agent', scriptName), 'utf8').replaceAll('\r\n', '\n')
    .replaceAll('/etc/systemd/system', posix(join(root, 'systemd')))
    .replaceAll('/etc/init.d', posix(join(root, 'init')))
    .replaceAll('/etc/conf.d', posix(join(root, 'env')))
    .replaceAll('/Library/LaunchDaemons', posix(join(root, 'launchd')))
    .replaceAll('/usr/libexec/PlistBuddy', 'plist_buddy')
    .replaceAll('ENV_FILE="/etc/$SERVICE_NAME.env"', `ENV_FILE=${shellQuote(posix(join(root, 'env')))}"/$SERVICE_NAME.env"`);
  const definitions = source.split(scriptName === 'install.sh'
    ? /^while \[ "\$#" -gt 0 \]; do/m : /^while \[\[ \$# -gt 0 \]\]; do/m)[0];
  const generate = scriptName === 'install.sh' ? { systemd: 'install_systemd', openrc: 'install_openrc', launchctl: 'install_launchctl' }[mode]
    : `(\n${source.slice(source.indexOf('reject_env_value() {'))}\n)`;
  const script = `${definitions}
ROOT=${shellQuote(posix(root))}
INSTALL_DIR=${shellQuote(posix(installDirectory))}; STATE_DIR="$INSTALL_DIR/state"; RUNNER_FILE="$INSTALL_DIR/run-agent.sh"
SERVICE_MODE=${shellQuote(mode)}; PLATFORM_OS=${mode === 'launchctl' ? 'darwin' : 'linux'}; SERVICE_NAME=${shellQuote(serviceName)}; BASE_ID=fixture; INSTANCE_ID=fixture
ENV_FILE="$ROOT/env/$SERVICE_NAME${mode === 'systemd' ? '.env' : ''}"
[ "$SERVICE_MODE" != launchctl ] || ENV_FILE=''
UNIT_FILE="$ROOT/systemd/$SERVICE_NAME.service"; INIT_FILE="$ROOT/init/$SERVICE_NAME"; PLIST_FILE="$ROOT/launchd/$SERVICE_NAME.plist"
DRY_RUN=0; AGENT_USER=fixture; KEEP_FILES=${keepFiles ? '1' : '0'}; WORK_BIN="$ROOT/synthetic-binary"
SERVER=https://monitor.example.test; TOKEN=synthetic-token; NODE_NAME=synthetic-node; MODE=websocket
INTERVAL=3; PING_INTERVAL=120; TRAFFIC_RESET_DAY=1
run() {
  if [ "$1" = mkdir ] || [ "$1" = install ]; then "$@"; else
    printf 'ACTION'; for arg in "$@"; do printf ' <%s>' "$arg"; done; printf '\\n'
    if [ ${options.failRemoval ? '1' : '0'} = 1 ] && [ "$1" = rm ] && [ "$2" = -f ]; then return 9; fi
  fi
}
ensure_agent_user() { :; }
launchctl() { :; }
plist_buddy() { python -X utf8 "$ROOT/plist.py" "$@"; }
${scriptName === 'install-linux.sh' ? 'agent_assert_instance 0\nrun mkdir -p "$INSTALL_DIR" "$STATE_DIR"\nrun install -m 0755 "$WORK_BIN" "$INSTALL_DIR/cf-vps-monitor-agent"' : ''}
${generate}
${options.legacyOwnership ? 'rm -f "$INSTALL_DIR/.cf-vps-monitor-owned"' : ''}
agent_remove_prefixed_system_instances
`;
  const scriptPath = join(root, 'owned.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync(scriptName === 'install.sh' ? 'sh' : bashExecutable(), [posix(scriptPath)], {
    encoding: 'utf8', timeout: 25_000, windowsHide: true,
  });
  assert.ifError(result.error);
  return { root, result, installDirectory };
}

test('R-A06 encoded owned service directories remain discoverable for removal', async t => {
  for (const [script, mode] of [['install.sh', 'systemd'], ['install.sh', 'openrc'], ['install-linux.sh', 'systemd']]) {
    await t.test(`${script} ${mode}`, t => {
      const { result } = unixOwnedSystemFixture(t, script, mode);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Uninstalled cf-vps-monitor-agent-fixture\./, 'path decoding must still reach the owned instance');
      assert.doesNotMatch(result.stderr, /Skipping unowned/);
    });
  }
});

test('R-A06 newline paths fail before generation', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) {
    await t.test(script, t => {
      const { root, result } = generatedServiceFixture(t, script, 'systemd', '/srv/synthetic\nnew-line');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /line breaks/);
      assert.equal(existsSync(join(root, 'generated.service')), false);
    });
  }
});

test('R-A07 Unix uninstall-all discovers every name and directory combination', async t => {
  for (const [script, mode] of [['install.sh', 'systemd'], ['install.sh', 'openrc'], ['install.sh', 'launchctl'],
    ['install-linux.sh', 'systemd'], ['install-linux.sh', 'launchctl']]) {
    for (const customName of [false, true]) for (const defaultDirectory of [true, false]) {
      const name = customName ? 'local-monitor-fixture' : 'cf-vps-monitor-agent-fixture';
      await t.test(`${script} ${mode} custom-name=${customName} custom-dir=${!defaultDirectory}`, t => {
        const { root, result, installDirectory } = unixOwnedSystemFixture(t, script, mode, name, false,
          { defaultDirectory, unrelated: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.stdout.includes(`Uninstalled ${name}.`), `owned instance was not discovered:\n${result.stdout}`);
        assert.ok(result.stdout.includes(`ACTION <rm> <-rf> <${posix(installDirectory)}>`), 'remove only the validated instance directory');
        assert.doesNotMatch(result.stdout, /ACTION[^\n]*cf-vps-monitor-agent-foreign/);
        assert.equal(readFileSync(join(root, 'unrelated', 'sentinel'), 'utf8'), 'unrelated content');
        assert.match(result.stdout, /discovered=1 completed=1 skipped=1 failed=0/);
      });
    }
  }
});

test('R-A07 Unix keep-files retains files and failed resource removal is reported', async t => {
  for (const mode of ['systemd', 'openrc', 'launchctl']) {
    await t.test(`${mode} keep-files`, t => {
      const { result, installDirectory } = unixOwnedSystemFixture(t, 'install.sh', mode, 'local-monitor-fixture', true);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /discovered=1 completed=1 skipped=0 failed=0/);
      assert.ok(!result.stdout.includes(`ACTION <rm> <-rf> <${posix(installDirectory)}>`));
    });
    await t.test(`${mode} failed removal`, t => {
      const { result, installDirectory } = unixOwnedSystemFixture(t, 'install.sh', mode,
        'cf-vps-monitor-agent-fixture', false, { failRemoval: true });
      assert.notEqual(result.status, 0, 'a failed resource removal cannot report success');
      assert.match(result.stdout, /discovered=1 completed=0 skipped=0 failed=1/);
      assert.doesNotMatch(result.stdout, /Uninstalled cf-vps-monitor-agent-fixture/);
      assert.ok(!result.stdout.includes(`ACTION <rm> <-rf> <${posix(installDirectory)}>`), 'keep instance files after failed service removal');
    });
  }
});

test('R-A07 Unix legacy ownership still discovers a custom service without a marker', async t => {
  for (const mode of ['systemd', 'openrc', 'launchctl']) await t.test(mode, t => {
    const { result } = unixOwnedSystemFixture(t, 'install.sh', mode, 'local-legacy-monitor', true, { legacyOwnership: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /discovered=1 completed=1 skipped=0 failed=0/);
  });
});

test('R-A07 OpenRC discovery never evaluates an untrusted directory expression', t => {
  const root = fixture(t);
  const canary = join(root, 'unexpected-execution');
  const resource = join(root, 'foreign.init');
  writeFileSync(resource, `directory='${posix(root)}'; printf invoked >${shellQuote(posix(canary))}\n`);
  const source = readFileSync(join(repo, 'agent', 'install.sh'), 'utf8').split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
  const script = join(root, 'read-directory.sh');
  writeFileSync(script, `${source}\nSERVICE_MODE=openrc\nagent_resource_directory ${shellQuote(posix(resource))}\n`);
  const result = spawnSync('sh', [posix(script)], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(canary), false);
});

function unixPreview(script, root, args) {
  const binary = join(root, 'synthetic-agent');
  writeFileSync(binary, 'synthetic fixture, never executed\n');
  const scriptPath = join(repo, 'agent', script);
  const result = spawnSync(script === 'install-linux.sh' ? bashExecutable() : 'sh', [
    posix(scriptPath), '--dry-run', ...args,
  ], {
    cwd: repo, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: {
      ...process.env,
      XDG_DATA_HOME: posix(join(root, 'data')),
      XDG_CONFIG_HOME: posix(join(root, 'config')),
      XDG_STATE_HOME: posix(join(root, 'state')),
      TMPDIR: posix(root),
    },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, null, 'the installer must finish, not time out');
  return result;
}

test('R-A01 Unix installers reject dot IDs before planning any mutation', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) {
    for (const id of ['.', '..']) {
      await t.test(`${script}: ${id}`, t => {
        const root = fixture(t);
        const mode = script === 'install.sh' ? ['--install-mode', 'user'] : [];
        const result = unixPreview(script, root, ['--uninstall', '--instance-id', id, ...mode]);
        assert.notEqual(result.status, 0, `dot ID ${id} was accepted:\n${result.stdout}`);
        assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'a rejected ID cannot reach any mutation plan');
      });
    }
  }
});

test('R-A01 Unix uninstall refuses an unowned custom directory', async t => {
  for (const script of ['install.sh', 'install-linux.sh']) {
    await t.test(script, t => {
      const root = fixture(t);
      const unrelated = join(root, 'unrelated-application');
      mkdirSync(unrelated);
      const sentinel = join(unrelated, 'sentinel.txt');
      writeFileSync(sentinel, 'unrelated application');
      const mode = script === 'install.sh' ? ['--install-mode', 'user'] : [];
      const result = unixPreview(script, root, [
        '--uninstall', '--instance-id', 'fixture', '--install-dir', posix(unrelated), ...mode,
      ]);
      assert.equal(readFileSync(sentinel, 'utf8'), 'unrelated application');
      assert.notEqual(result.status, 0, `unowned directory was accepted:\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'ownership must be checked before stop/remove plans');
    });
  }
});

test('R-A01 safe fresh user installation remains a valid dry-run control', t => {
  const root = fixture(t);
  const result = unixPreview('install.sh', root, [
    '--install-mode', 'user', '--instance-id', 'fixture',
    '--server', 'https://monitor.example.test', '--token', 'synthetic-token',
    '--binary', posix(join(root, 'synthetic-agent')),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\]/, 'the control must exercise the actual install plan');
});

test('R-A01 normalized shared directories and linked ancestors are rejected', async t => {
  for (const kind of ['shared-data', 'normalized-shared-data', 'linked-ancestor']) {
    await t.test(kind, t => {
      const root = fixture(t);
      let directory = join(root, 'data', 'cf-vps-monitor');
      if (kind === 'normalized-shared-data') directory = `${directory}/child/..`;
      if (kind === 'linked-ancestor') {
        const target = join(root, 'link-target');
        mkdirSync(target);
        const link = join(root, 'link');
        symlinkSync(target, link, isWindows ? 'junction' : 'dir');
        directory = join(link, 'fresh-instance');
      }
      const result = unixPreview('install.sh', root, [
        '--install-mode', 'user', '--instance-id', 'fixture', '--install-dir', posix(directory),
        '--server', 'https://monitor.example.test', '--token', 'synthetic-token',
        '--binary', posix(join(root, 'synthetic-agent')),
      ]);
      assert.notEqual(result.status, 0, `${kind} was accepted:\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'unsafe paths must not form mutation plans');
    });
  }
});

test('R-A01 fresh installation cannot claim an unrelated config or state path', async t => {
  for (const kind of ['config', 'state']) {
    await t.test(kind, t => {
      const root = fixture(t);
      const collision = kind === 'config'
        ? join(root, 'config', 'cf-vps-monitor', 'fixture.env')
        : join(root, 'state', 'cf-vps-monitor', 'fixture', 'sentinel.txt');
      mkdirSync(dirname(collision), { recursive: true });
      writeFileSync(collision, 'unrelated data');
      const result = unixPreview('install.sh', root, [
        '--install-mode', 'user', '--instance-id', 'fixture',
        '--server', 'https://monitor.example.test', '--token', 'synthetic-token',
        '--binary', posix(join(root, 'synthetic-agent')),
      ]);
      assert.equal(readFileSync(collision, 'utf8'), 'unrelated data');
      assert.notEqual(result.status, 0, `unrelated ${kind} path was accepted:\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'related paths also need ownership before mutation');
    });
  }
});

test('R-A01 generated user uninstaller parses and rejects invalidated ownership before stop', t => {
  const root = fixture(t);
  const directory = join(root, 'instance');
  const capture = join(root, 'uninstall.sh');
  const source = readFileSync(join(repo, 'agent', 'install.sh'), 'utf8').split(/^while \[ "\$#" -gt 0 \]; do/m)[0];
  const quoted = value => `'${posix(value).replaceAll("'", "'\\''")}'`;
  const script = `${source}
SERVICE_MODE=user; INSTANCE_ID=fixture; SERVICE_NAME=''; UNINSTALL=0; UNINSTALL_ALL=0
DRY_RUN=1; INSTALL_DIR=${quoted(directory)}
XDG_DATA_HOME=${quoted(join(root, 'data'))}; XDG_CONFIG_HOME=${quoted(join(root, 'config'))}; XDG_STATE_HOME=${quoted(join(root, 'state'))}
export XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME
run() { :; }
copy_binary_to() { :; }
install_user_autostart() { :; }
write_file() { if [ "$1" = "$INSTALL_DIR/uninstall.sh" ]; then printf '%s\\n' "$3" > ${quoted(capture)}; fi; }
WORK_BIN=${quoted(join(root, 'unused-binary'))}
apply_defaults
install_user_mode
`;
  const scriptPath = join(root, 'generate.sh');
  writeFileSync(scriptPath, script.replaceAll('\r\n', '\n'));
  const generated = spawnSync('sh', [scriptPath], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(generated.error);
  assert.equal(generated.status, 0, generated.stderr);
  const syntax = spawnSync('sh', ['-n', capture], { encoding: 'utf8', windowsHide: true });
  assert.equal(syntax.status, 0, syntax.stderr);
  mkdirSync(directory);
  const stopped = join(root, 'stop-was-called');
  writeFileSync(join(directory, 'stop.sh'), `#!/bin/sh\nprintf 'called' > ${quoted(stopped)}\n`, { mode: 0o755 });
  const rejected = spawnSync('sh', [capture], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0, 'unowned generated uninstall must fail');
  assert.match(rejected.stderr, /ownership|marker/i, 'failure must come from the ownership gate');
  assert.equal(existsSync(stopped), false, 'ownership is checked before stopping anything');
  assert.ok(existsSync(join(directory, 'stop.sh')), 'unowned files remain untouched');
  // A matching legacy user marker must still reach its own stop script. The
  // script deliberately refuses to stop, so this control performs no deletion.
  const environment = join(root, 'config', 'cf-vps-monitor', 'fixture.env');
  const state = join(root, 'state', 'cf-vps-monitor', 'fixture');
  mkdirSync(dirname(environment), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(environment, 'CF_MONITOR_TOKEN=synthetic-token\n');
  writeFileSync(join(state, 'install-dir'), `${posix(directory)}\n`);
  writeFileSync(join(directory, 'cf-vps-monitor-agent'), 'synthetic executable');
  writeFileSync(join(directory, 'run-agent.sh'), `. ${quoted(environment)}\n`);
  writeFileSync(join(directory, '.cf-vps-monitor-instance'), `fixture\n${posix(environment)}\n${posix(state)}\n`);
  writeFileSync(join(directory, 'stop.sh'), `#!/bin/sh\nprintf 'called' > ${quoted(stopped)}\nexit 7\n`, { mode: 0o755 });
  const owned = spawnSync('sh', [capture], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(owned.error);
  assert.equal(existsSync(stopped), true, `proven legacy instance was not accepted:\n${owned.stderr}`);
  assert.notEqual(owned.status, 0, 'a failed stop cannot proceed to deletion');
  assert.ok(existsSync(join(directory, 'cf-vps-monitor-agent')), 'failed stop retains owned files');
});

function windowsPreview(root, directory, tasks, options = {}, services = []) {
  const optionsFile = join(root, 'options.json');
  const tasksFile = join(root, 'tasks.json');
  const servicesFile = join(root, 'services.json');
  writeFileSync(optionsFile, JSON.stringify({
    Server: 'https://monitor.example.test', Token: 'synthetic-token',
    BinaryPath: join(root, 'synthetic-agent.exe'), InstanceId: 'fixture',
    ServiceName: 'shared-task-name', InstallDir: directory, ...options,
  }));
  writeFileSync(tasksFile, JSON.stringify(tasks));
  writeFileSync(servicesFile, JSON.stringify(services));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    join(repo, 'agent', 'testdata', 'reaudit-windows-preview.ps1'),
    '-Installer', join(repo, 'agent', 'install-windows.ps1'),
    '-Root', root, '-OptionsFile', optionsFile, '-TasksFile', tasksFile,
    '-ServicesFile', servicesFile,
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, null, 'the installer must finish, not time out');
  assert.deepEqual(JSON.parse(readFileSync(tasksFile, 'utf8')), tasks, 'synthetic task data remains unchanged');
  return result;
}

function ownTask(directory, serviceName = 'shared-task-name') {
  return {
    TaskName: serviceName, TaskPath: '\\', State: 'Ready',
    Actions: [{
      Execute: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      Arguments: `-NoProfile -ExecutionPolicy Bypass -File "${join(directory, 'run-agent.ps1')}"`,
      WorkingDirectory: directory,
    }],
  };
}

function markWindowsInstance(directory, serviceName = 'shared-task-name') {
  mkdirSync(join(directory, 'state'), { recursive: true });
  writeFileSync(join(directory, 'cf-vps-monitor-agent.exe'), 'synthetic previous executable');
  writeFileSync(join(directory, 'run-agent.ps1'), '# synthetic previous runner');
  writeFileSync(join(directory, '.cf-vps-monitor-instance.json'), JSON.stringify({
    application: 'cf-vps-monitor-agent', version: 1, instance_id: 'fixture',
    service_name: serviceName, install_dir: directory,
  }));
}

test('R-A07 Windows uninstall-all discovers all name/directory combinations once', { skip: !isWindows }, async t => {
  for (const keepFiles of [false, true]) await t.test(`keep-files=${keepFiles}`, t => {
    const root = fixture(t);
    const tasks = [];
    const directories = [];
    for (const customName of [false, true]) for (const customDirectory of [false, true]) {
      const index = tasks.length;
      const name = customName ? `local-monitor-${index}` : `CFVpsMonitorAgent-fixture-${index}`;
      const directory = join(root, ...(customDirectory ? ['custom'] : ['program-files', 'CF VPS Monitor']), `fixture-${index}`);
      markWindowsInstance(directory, name);
      tasks.push(ownTask(directory, name));
      directories.push(directory);
    }
    const result = windowsPreview(root, join(root, 'unused'), tasks, { UninstallAll: true, Yes: true, KeepFiles: keepFiles });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const task of tasks) {
      const action = `Unregister-ScheduledTask -TaskName "${task.TaskName}"`;
      assert.equal(result.stdout.split(action).length - 1, 1, `owned task must be discovered exactly once:\n${result.stdout}`);
    }
    for (const directory of directories) {
      assert.equal(result.stdout.includes(`Remove owned instance directory "${directory}"`), !keepFiles);
      assert.ok(existsSync(join(directory, '.cf-vps-monitor-instance.json')), 'DryRun never removes fixture files');
    }
    assert.match(result.stdout, /discovered=4 completed=4 skipped=0 failed=0/);
  });
});

test('R-A07 Windows skips unowned, extra-action and non-root task resources', { skip: !isWindows }, async t => {
  for (const variant of ['unowned', 'extra-action', 'non-root']) await t.test(variant, t => {
    const root = fixture(t);
    const directory = join(root, 'custom', 'fixture');
    const name = 'local-monitor-foreign';
    markWindowsInstance(directory, name);
    const task = ownTask(directory, name);
    if (variant === 'unowned') task.Actions[0].Execute = 'other-program.exe';
    if (variant === 'extra-action') task.Actions.push({ Execute: 'other-program.exe', Arguments: '', WorkingDirectory: directory });
    if (variant === 'non-root') task.TaskPath = '\\OtherFolder\\';
    const result = windowsPreview(root, join(root, 'unused'), [task], { UninstallAll: true, Yes: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'unowned task resources cannot form removal plans');
    assert.match(result.stdout, /discovered=0 completed=0 skipped=1 failed=0/);
    assert.ok(existsSync(join(directory, 'cf-vps-monitor-agent.exe')));
  });
});

test('R-A07 Windows reports a failed removal and still processes the next owned instance', { skip: !isWindows }, t => {
  const root = fixture(t);
  const failedDirectory = join(root, 'custom', 'failed');
  const successDirectory = join(root, 'custom', 'success');
  const failedName = 'CFVpsMonitorAgent-failed';
  const successName = 'CFVpsMonitorAgent-success';
  markWindowsInstance(failedDirectory, failedName);
  markWindowsInstance(successDirectory, successName);
  const tasksFile = join(root, 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify([ownTask(failedDirectory, failedName), ownTask(successDirectory, successName)]));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    join(repo, 'agent', 'testdata', 'reaudit-windows-uninstall.ps1'), '-Installer', join(repo, 'agent', 'install-windows.ps1'),
    '-Root', root, '-TasksFile', tasksFile, '-FailTaskName', failedName],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'partial failure must have a failing exit code');
  assert.ok(result.stdout.includes(`Unregister-ScheduledTask -TaskName "${successName}"`), 'the second independent instance must still be processed');
  assert.ok(!result.stdout.includes(`Remove owned instance directory "${failedDirectory}"`));
  assert.match(result.stdout, /discovered=2 completed=1 skipped=0 failed=1/);
});

test('R-A07 Windows finds a marked custom legacy service and deduplicates task plus service', { skip: !isWindows }, async t => {
  for (const withTask of [false, true]) await t.test(`task=${withTask}`, t => {
    const root = fixture(t);
    const directory = join(root, 'custom', 'old-install');
    const name = 'local-legacy-monitor';
    markWindowsInstance(directory, name);
    const services = [{ Name: name, Status: 'Running', PathName: `"${join(directory, 'cf-vps-monitor-agent.exe')}" --interval 3` }];
    const result = windowsPreview(root, join(root, 'unused'), withTask ? [ownTask(directory, name)] : [],
      { UninstallAll: true, Yes: true }, services);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.split(`sc.exe delete "${name}"`).length - 1, 1);
    assert.equal(result.stdout.split(`Remove owned instance directory "${directory}"`).length - 1, 1);
    assert.match(result.stdout, /discovered=1 completed=1 skipped=0 failed=0/);
  });
});

test('R-A07 Windows discovers a proven legacy task with custom name and directory', { skip: !isWindows }, t => {
  const root = fixture(t);
  const directory = join(root, 'custom', 'legacy-fixture');
  const name = 'local-old-monitor';
  markWindowsInstance(directory, name);
  rmSync(join(directory, '.cf-vps-monitor-instance.json'));
  const result = windowsPreview(root, join(root, 'unused'), [ownTask(directory, name)], { UninstallAll: true, Yes: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /discovered=1 completed=1 skipped=0 failed=0/);
  assert.ok(result.stdout.includes(`Unregister-ScheduledTask -TaskName "${name}"`));
});

test('R-A02 Windows rejects unrelated same-name tasks before planning mutation', { skip: !isWindows }, async t => {
  for (const variant of ['new-directory', 'empty-directory', 'marked-directory', 'extra-action', 'wrong-runner', 'non-root-task-path']) {
    await t.test(variant, t => {
      const root = fixture(t);
      const directory = join(root, 'instance');
      if (variant !== 'new-directory') mkdirSync(directory);
      if (variant === 'marked-directory') markWindowsInstance(directory);
      const task = ownTask(directory);
      if (variant === 'extra-action') {
        task.Actions.push({ Execute: 'unrelated.exe', Arguments: '--unrelated', WorkingDirectory: root });
      } else if (variant === 'wrong-runner') {
        task.Actions[0].Arguments = `-NoProfile -ExecutionPolicy Bypass -File "${join(root, 'unrelated.ps1')}"`;
      } else if (variant === 'non-root-task-path') {
        task.TaskPath = '\\UnrelatedFolder\\';
      } else {
        task.Actions = [{ Execute: 'unrelated.exe', Arguments: '--unrelated', WorkingDirectory: root }];
      }
      const result = windowsPreview(root, directory, [task]);
      assert.notEqual(result.status, 0, `${variant} allowed task takeover:\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'task identity must be checked before file/ACL/task plans');
    });
  }
});

test('R-A02 Windows accepts collision-free new and correctly owned existing instances', { skip: !isWindows }, async t => {
  for (const existing of [false, true]) {
    await t.test(existing ? 'owned-existing' : 'new-without-collision', t => {
      const root = fixture(t);
      const directory = join(root, 'instance');
      if (existing) markWindowsInstance(directory);
      const result = windowsPreview(root, directory, existing ? [ownTask(directory)] : []);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[dry-run\]/, 'the control must exercise the actual install plan');
    });
  }
});
