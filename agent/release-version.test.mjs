import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const posix = path => path.replaceAll('\\', '/');
const bash = process.platform === 'win32'
  ? join(dirname(dirname(spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)[0])), 'bin', 'bash.exe')
  : 'bash';

function validationCommands() {
  const workflow = readFileSync(join(repo, '.github', 'workflows', 'release-agent.yml'), 'utf8');
  const block = workflow.split('      - name: Validate immutable release version')[1]?.split('      - name:')[0];
  assert.ok(block, 'use the actual immutable-release validation step');
  const script = block.split('        run: |')[1];
  assert.ok(script);
  return script.split(/\r?\n/).filter(line => /^          /.test(line) || !line.trim()).map(line => line.slice(10)).join('\n');
}

function scripts(root) {
  const paths = {};
  for (const name of ['install.sh', 'install-linux.sh']) {
    const source = readFileSync(join(repo, 'agent', name), 'utf8');
    const definitions = source.split(name === 'install.sh' ? /^while \[ "\$#" -gt 0 \]; do/m : /^while \[\[ \$# -gt 0 \]\]; do/m)[0];
    paths[name] = join(root, name);
    writeFileSync(paths[name], `${definitions}\nCF_MONITOR_RELEASE_TAG="$REAUDIT_RELEASE_TAG"\nset_release_base\nprintf '%s\\n' "$CF_MONITOR_RELEASE_BASE"\n`);
  }
  const windows = readFileSync(join(repo, 'agent', 'install-windows.ps1'), 'utf8');
  const end = windows.indexOf('$releaseBase = Resolve-ReleaseBase');
  assert.ok(end > 0);
  paths['install-windows.ps1'] = join(root, 'install-windows.ps1');
  writeFileSync(paths['install-windows.ps1'], windows.slice(0, end) + '\n$ReleaseTag = $env:REAUDIT_RELEASE_TAG\nResolve-ReleaseBase\n');
  paths.validation = join(root, 'validate.sh');
  writeFileSync(paths.validation, `
git() {
  printf 'git' >&3; printf ' <%s>' "$@" >&3; printf '\\n' >&3
  case "$1" in rev-parse) printf '%s\\n' "$GITHUB_SHA" ;; ls-remote) return 2 ;; *) return 99 ;; esac
}
gh() {
  printf 'gh' >&3; printf ' <%s>' "$@" >&3; printf '\\n' >&3
  [ "$1" = api ] && [ "$2" = --paginate ] || return 99
}
node() {
  [ "$1" = ../scripts/verify-release-assets.mjs ] || return 99
  shift
  "$NODE_EXECUTABLE" "$REAL_VERIFY_SCRIPT" "$@"
}
exec 3> "$REAUDIT_COMMAND_LOG"
${validationCommands()}
`);
  return paths;
}

test('R-A09 every publishable version resolves through all three real installers', async t => {
  const parent = join(repo, 'worker', '.tmp', 'reaudit-agent-release');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.ok(resolved.startsWith(realpathSync(parent) + sep));
    assert.equal(dirname(resolved), realpathSync(parent));
    rmSync(resolved, { recursive: true, force: true });
  });
  const paths = scripts(root);
  const vectors = [
    { tag: '', publish: false, pin: true },
    { tag: 'v1.2.3', publish: true, pin: true },
    { tag: 'v1.2.3-rc.1', publish: true, pin: true },
    { tag: 'v1.2.3+build.01', publish: true, pin: true },
    { tag: 'v1.2.3-rc.1+build.5', publish: true, pin: true },
    { tag: 'v1.2.3+' + 'a'.repeat(121), publish: true, pin: true },
    { tag: 'v1.2.3+' + 'a'.repeat(122), publish: false, pin: false },
    { tag: 'stable_2026-09', publish: false, pin: true },
    { tag: 'v01.2.3', publish: false, pin: true },
    { tag: 'v1.2.3-01', publish: false, pin: true },
    { tag: 'v1.2.3.legacy', publish: false, pin: true },
    ...['--help', '.', '..', '.hidden', 'v1.2.3/', 'v1.2.3\\x', 'v1.2.3%2Bmeta', 'v1.2.3+meta.lock',
      'v1.2.3+foo+bar', 'v1.2.3+', 'v1.2.3-alpha..1', 'v1.2.3-rc_1+build', 'v1.2.3;echo',
      ' ', 'v1.2.3\n', 'v1.2.3\nv1.2.4', 'v1.2.3\r'].map(tag => ({ tag, publish: false, pin: false })),
  ];
  for (const vector of vectors) await t.test(JSON.stringify(vector.tag), () => {
    const commandLog = join(root, 'commands.log');
    const env = { ...process.env, REAUDIT_RELEASE_TAG: vector.tag, AGENT_VERSION: vector.tag,
      GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'synthetic/repository', GITHUB_ENV: posix(join(root, 'github-env')),
      REAUDIT_COMMAND_LOG: posix(commandLog), NODE_EXECUTABLE: process.execPath,
      REAL_VERIFY_SCRIPT: join(repo, 'scripts', 'verify-release-assets.mjs') };
    const released = spawnSync(bash, [posix(paths.validation)], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.ifError(released.error);
    const failures = [];
    if ((released.status === 0) !== vector.publish) failures.push(`release: expected ${vector.publish ? 'accept' : 'reject'}, exit=${released.status}, ${released.stdout}${released.stderr}`);
    if (!vector.publish && released.status !== 0 && existsSync(commandLog) && readFileSync(commandLog, 'utf8').trim()) {
      failures.push('invalid release must be rejected before git/gh lookups');
    }
    for (const name of ['install.sh', 'install-linux.sh', 'install-windows.ps1']) {
      const result = name === 'install-windows.ps1'
        ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', paths[name], '-DryRun'],
          { env, encoding: 'utf8', timeout: 15_000, windowsHide: true })
        : spawnSync(name === 'install.sh' ? 'sh' : bash, [posix(paths[name])],
          { env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
      assert.ifError(result.error);
      if ((result.status === 0) !== vector.pin) failures.push(`${name}: expected ${vector.pin ? 'accept' : 'reject'}, exit=${result.status}, ${result.stdout}${result.stderr}`);
      if (vector.pin && result.status === 0) {
        const expected = vector.tag ? `https://github.com/kadidalax/cf-vps-monitor/releases/download/${encodeURIComponent(vector.tag)}`
          : 'https://github.com/kadidalax/cf-vps-monitor/releases/latest/download';
        if (result.stdout.trim() !== expected) failures.push(`${name}: decoded/encoded repository+tag path is not equivalent: ${result.stdout}`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });
});
