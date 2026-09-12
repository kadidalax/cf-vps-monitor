import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const agent = join(repo, 'agent');
const cachedGo = 'C:/Users/Administrator/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.8.windows-amd64/bin/go.exe';
const go = existsSync(cachedGo) ? cachedGo : 'go';

test('R-A08 real ICMP execution uses each platform and family command contract', t => {
  const parent = join(repo, 'worker', '.tmp', 'reaudit-agent-ping');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.ok(resolved.startsWith(realpathSync(parent) + sep));
    assert.equal(dirname(resolved), realpathSync(parent));
    rmSync(resolved, { recursive: true, force: true });
  });
  const executable = join(root, process.platform === 'win32' ? 'ping-fixture.exe' : 'ping-fixture');
  const build = spawnSync(go, ['build', '-o', executable, './testdata/ping_fixture.go'], {
    cwd: agent, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assert.ifError(build.error);
  assert.equal(build.status, 0, `test fixture must compile before any behavioral check:\n${build.stdout}${build.stderr}`);
  const mainPath = join(agent, 'main.go');
  const source = readFileSync(mainPath, 'utf8');
  const start = source.indexOf('func executeICMPPingWithContext(');
  const end = source.indexOf('\nfunc ', start + 1);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.equal(body.split('runtime.GOOS').length - 1, 1, 'overlay changes only the real ICMP platform selector');
  const overlaid = join(root, 'main.go');
  writeFileSync(overlaid, source.slice(0, start) + body.replace('runtime.GOOS', 'reauditPingPlatform') + source.slice(end));
  const overlay = join(root, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace: { [mainPath]: overlaid } }));
  const checked = spawnSync(go, ['test', '-overlay', overlay, '-count=1', '-timeout', '35s', '-run', '^TestReauditICMPPlatform$', '-v', '.'], {
    cwd: agent, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, REAUDIT_PING_OVERLAY: '1', REAUDIT_PING_FIXTURE: executable },
  });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, `real command regression:\n${checked.stdout}${checked.stderr}`);
  t.diagnostic(checked.stdout.trim());
});
