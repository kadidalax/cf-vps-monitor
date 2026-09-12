import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const installer = fileURLToPath(new URL('./install-windows.ps1', import.meta.url));
const windows = process.platform === 'win32';

function temporaryRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cf-agent-test-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('cf-agent-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function preview(args, root, tasks) {
  const options = { Server: 'https://monitor.example.test', Token: 'synthetic-test-token', BinaryPath: path.join(root, 'fixture.exe') };
  for (let index = 0; index < args.length; index += 2) options[args[index].slice(1)] = args[index + 1];
  const optionsFile = path.join(root, 'preview-options.json');
  writeFileSync(optionsFile, JSON.stringify(options));
  const taskArgs = [];
  if (tasks) {
    const taskFile = path.join(root, 'preview-tasks.json');
    writeFileSync(taskFile, JSON.stringify(tasks));
    taskArgs.push('-LegacyTaskFile', taskFile);
  }
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./testdata/windows-preview.ps1', import.meta.url)),
    '-Installer', installer, '-Root', root, '-OptionsFile', optionsFile, ...taskArgs], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
}

test('AUD-10 rejects dot instance IDs before the first planned change', { skip: !windows }, t => {
  const root = temporaryRoot(t);
  for (const id of ['.', '..']) {
    const result = preview(['-InstanceId', id], root);
    assert.notEqual(result.status, 0, `unsafe instance ${id} was accepted:\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'rejected input must not form a mutation plan');
  }
});

test('AUD-10 rejects normalized roots, shared parents and unowned directories', { skip: !windows }, t => {
  const root = temporaryRoot(t);
  const unrelated = path.join(root, 'unrelated-app');
  mkdirSync(unrelated);
  writeFileSync(path.join(unrelated, 'sentinel.txt'), 'unrelated');
  const programFiles = path.join(root, 'program-files');
  for (const directory of [path.parse(root).root + 'temp\\..', programFiles,
    path.join(programFiles, 'CF VPS Monitor'), path.join(programFiles, 'CF VPS Monitor', '..'), unrelated]) {
    const result = preview(['-InstanceId', 'safe', '-InstallDir', directory], root);
    assert.notEqual(result.status, 0, `unsafe directory accepted: ${directory}\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /\[dry-run\]/);
  }
  assert.equal(readFileSync(path.join(unrelated, 'sentinel.txt'), 'utf8'), 'unrelated');
});

test('AUD-10 preserves safe default and Chinese instance sanitization', { skip: !windows }, t => {
  const root = temporaryRoot(t);
  for (const [id, expected] of [['default', 'default'], ['上海 节点', 'default'], ['cn-上海-01', 'cn---01']]) {
    const result = preview(['-InstanceId', id], root);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(root, 'program-files', 'CF VPS Monitor', expected)), result.stdout);
  }
});

test('AUD-10 custom uninstall requires a matching marker and rejects junction traversal', { skip: !windows }, t => {
  const root = temporaryRoot(t);
  const owned = path.join(root, 'custom-agent');
  mkdirSync(owned);
  writeFileSync(path.join(owned, 'sentinel.txt'), 'owned-fixture');
  const marker = { application: 'cf-vps-monitor-agent', version: 1, instance_id: 'safe',
    service_name: 'CFVpsMonitorAgent-safe', install_dir: owned };
  writeFileSync(path.join(owned, '.cf-vps-monitor-instance.json'), JSON.stringify(marker));
  const good = preview(['-InstanceId', 'safe', '-InstallDir', owned, '-Uninstall', true], root);
  assert.equal(good.status, 0, good.stderr);
  const wrong = preview(['-InstanceId', 'other', '-InstallDir', owned, '-Uninstall', true], root);
  assert.notEqual(wrong.status, 0, wrong.stdout);
  assert.doesNotMatch(wrong.stdout, /\[dry-run\]/);
  const junction = path.join(root, 'junction');
  symlinkSync(owned, junction, 'junction');
  const unsafe = preview(['-InstanceId', 'safe', '-InstallDir', junction, '-Uninstall', true], root);
  assert.notEqual(unsafe.status, 0, unsafe.stdout);
  assert.doesNotMatch(unsafe.stdout, /\[dry-run\]/);
  assert.equal(readFileSync(path.join(owned, 'sentinel.txt'), 'utf8'), 'owned-fixture');
});

function legacyInstall(root, defaultLocation) {
  const directory = defaultLocation
    ? path.join(root, 'program-files', 'CF VPS Monitor', 'fixture')
    : path.join(root, 'custom-上海');
  mkdirSync(path.join(directory, 'state'), { recursive: true });
  writeFileSync(path.join(directory, 'cf-vps-monitor-agent.exe'), 'preview-only binary');
  writeFileSync(path.join(directory, 'run-agent.ps1'), '# preview-only prior runner');
  writeFileSync(path.join(directory, 'state', 'agent.log'), 'prior log');
  writeFileSync(path.join(directory, 'state', 'runner.log'), 'prior runner log');
  writeFileSync(path.join(directory, 'state', 'traffic-state.json'), '{}');
  writeFileSync(path.join(directory, 'state', 'traffic-state.json.tmp'), '{}');
  const task = { TaskName: 'CFVpsMonitorAgent-fixture', TaskPath: '\\', Actions: [{
    Execute: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    Arguments: `-NoProfile -ExecutionPolicy Bypass -File "${path.join(directory, 'run-agent.ps1')}"`,
    WorkingDirectory: directory,
  }] };
  return { directory, task };
}

test('AUD-10 adopts a proven legacy default or custom installation for upgrade', { skip: !windows }, t => {
  for (const defaultLocation of [true, false]) {
    const root = temporaryRoot(t);
    const { directory, task } = legacyInstall(root, defaultLocation);
    const result = preview(['-InstanceId', 'fixture', '-InstallDir', directory], root, [task]);
    assert.equal(result.status, 0, `legacy ${defaultLocation ? 'default' : 'custom'} upgrade was refused:\n${result.stderr}`);
    assert.ok(result.stdout.includes(directory), result.stdout);
    assert.equal(readFileSync(path.join(directory, 'state', 'agent.log'), 'utf8'), 'prior log');
  }
});

test('AUD-10 legacy ownership rejects extra actions, wrong executable and unrelated contents', { skip: !windows }, t => {
  for (const variant of ['wrong-executable', 'extra-action', 'wrong-runner', 'wrong-working-directory',
    'duplicate-task', 'unknown-file', 'unknown-state', 'state-directory']) {
    for (const defaultLocation of [true, false]) {
      const root = temporaryRoot(t);
      const { directory, task } = legacyInstall(root, defaultLocation);
      if (variant === 'wrong-executable') task.Actions[0].Execute = path.join(root, 'unrelated.exe');
      if (variant === 'extra-action') task.Actions.push({ ...task.Actions[0], Execute: path.join(root, 'unrelated.exe') });
      if (variant === 'wrong-runner') task.Actions[0].Arguments += ' -UnknownArgument';
      if (variant === 'wrong-working-directory') task.Actions[0].WorkingDirectory = root;
      if (variant === 'unknown-file') writeFileSync(path.join(directory, 'unrelated.txt'), 'do not touch');
      if (variant === 'unknown-state') writeFileSync(path.join(directory, 'state', 'unrelated.txt'), 'do not touch');
      if (variant === 'state-directory') mkdirSync(path.join(directory, 'state', 'unrelated'));
      const tasks = variant === 'duplicate-task' ? [task, { ...task }] : [task];
      const result = preview(['-InstanceId', 'fixture', '-InstallDir', directory], root, tasks);
      assert.notEqual(result.status, 0, `${variant} established legacy ownership:\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /\[dry-run\]/, 'ownership rejection must precede the mutation plan');
      if (variant === 'unknown-file') assert.equal(readFileSync(path.join(directory, 'unrelated.txt'), 'utf8'), 'do not touch');
      if (variant === 'unknown-state') assert.equal(readFileSync(path.join(directory, 'state', 'unrelated.txt'), 'utf8'), 'do not touch');
    }
  }
});

test('AUD-10 an existing mismatched marker cannot be bypassed by a legacy task', { skip: !windows }, t => {
  const root = temporaryRoot(t);
  const { directory, task } = legacyInstall(root, false);
  writeFileSync(path.join(directory, '.cf-vps-monitor-instance.json'), JSON.stringify({ application: 'different-application' }));
  const result = preview(['-InstanceId', 'fixture', '-InstallDir', directory], root, [task]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /\[dry-run\]/);
});

function buildFixture(t, goodSource) {
  const root = temporaryRoot(t);
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./testdata/windows-build.ps1', import.meta.url)),
    '-Installer', installer, '-Root', root, ...(goodSource ? ['-GoodSource'] : [])], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  return { ...outcome, stderr: result.stderr };
}

test('AUD-26 a failed real Go build never selects the stale TEMP binary', { skip: !windows }, t => {
  const result = buildFixture(t, false);
  assert.ok(result.failed, `build failure did not stop selection: ${JSON.stringify(result)}`);
  assert.equal(result.selected, false);
});

test('AUD-26 a successful real Go build selects a fresh independent output', { skip: !windows }, t => {
  const result = buildFixture(t, true);
  assert.equal(result.failed, false, result.error);
  assert.equal(result.selected, true);
  assert.notEqual(result.binary, result.stalePath);
  assert.ok(result.length > 1000);
});

function upgradeFixture(t, failStart, unicodeConfig = false) {
  const root = temporaryRoot(t);
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./testdata/windows-upgrade.ps1', import.meta.url)),
    '-Installer', installer, '-Root', root, ...(failStart ? ['-FailStart'] : []), ...(unicodeConfig ? ['-UnicodeConfig'] : [])], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(line => line.startsWith('{')).at(-1));
}

test('AUD-25 upgrades a genuinely running executable and applies the new environment', { skip: !windows }, t => {
  const result = upgradeFixture(t, false);
  assert.equal(result.failed, false, result.error);
  assert.equal(result.oldExited, true);
  assert.equal(result.marker, 'new');
  assert.equal(result.token, 'new-token');
  assert.equal(result.taskState, 'Running');
});

test('AUD-25 a start failure restores the old executable and task', { skip: !windows }, t => {
  const result = upgradeFixture(t, true);
  assert.equal(result.failed, true);
  assert.match(result.error, /injected start failure/);
  assert.equal(result.restored, true);
  assert.equal(result.marker, 'old');
  assert.equal(result.token, 'old-token');
  assert.equal(result.taskState, 'Running');
});

test('AUD-54 the generated runner preserves Unicode quotes and backslashes in the actual child environment', { skip: !windows }, t => {
  const result = upgradeFixture(t, false, true);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.failed, false, result.error);
  assert.equal(result.name, "上海'节点\\A");
  assert.equal(result.nicInclude, "网卡\\eth'");
  assert.equal(result.mountInclude, "C:\\数据,D:\\x'x");
});
