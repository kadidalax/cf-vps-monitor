import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(root, 'worker', '.tmp', 'audit-release-tests');
const workflow = await readFile(new URL('../.github/workflows/release-agent.yml', import.meta.url), 'utf8');

function releaseCommands(source) {
  const lines = source.split(/\r?\n/);
  const selected = [];
  let name = '';
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^      - name: (.+)$/);
    if (match) name = match[1];
    if (!/^        run: \|/.test(lines[index]) || !/immutable|release tags|Verify published/i.test(name)) continue;
    const script = [];
    while (++index < lines.length && (/^          /.test(lines[index]) || !lines[index].trim())) script.push(lines[index].slice(10));
    index -= 1;
    selected.push(script.join('\n'));
  }
  assert.ok(selected.length >= 2, 'exercise the real release workflow commands');
  return selected.join('\n');
}

async function fixture({ tag = false, release = false, failUpload = false, badDigest = false, version = 'v9.0.0' } = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'run-'));
  try {
    const agent = join(directory, 'agent');
    await mkdir(join(agent, 'dist'), { recursive: true });
    const content = Buffer.from('synthetic release binary');
    await writeFile(join(agent, 'dist', 'agent-fixture'), content);
    const metadata = join(directory, 'remote.json');
    await writeFile(metadata, JSON.stringify({ tag_name: version, target_commitish: 'a'.repeat(40), draft: true,
      assets: [{ name: 'agent-fixture', size: content.length, digest: `sha256:${badDigest ? '0'.repeat(64) : createHash('sha256').update(content).digest('hex')}` }] }));
    const log = join(directory, 'commands.log');
    await writeFile(log, '');
    const script = join(directory, 'fixture.sh');
    await writeFile(script, `
set -euo pipefail
git() {
  printf 'git' >> "$AUDIT_COMMAND_LOG"; printf ' %s' "$@" >> "$AUDIT_COMMAND_LOG"; printf '\\n' >> "$AUDIT_COMMAND_LOG"
  case "$1" in
    ls-remote) if [ "$TAG_PRESENT" = 1 ]; then printf '%s\\trefs/tags/%s\\n' "$TAG_SHA" "$AGENT_VERSION"; return 0; else return 2; fi ;;
    tag) TAG_PRESENT=1; TAG_SHA="$GITHUB_SHA" ;;
    config|push) return 0 ;;
    rev-parse) printf '%s\\n' "$GITHUB_SHA" ;;
    *) printf 'Unexpected git call\\n' >&2; return 99 ;;
  esac
}
gh() {
  printf 'gh' >> "$AUDIT_COMMAND_LOG"; printf ' %s' "$@" >> "$AUDIT_COMMAND_LOG"; printf '\\n' >> "$AUDIT_COMMAND_LOG"
  if [ "$1" = api ]; then
    if [[ "$*" == *--paginate* ]]; then [ "$RELEASE_PRESENT" = 0 ] || printf '%s\\n' "$AGENT_VERSION"; return 0; fi
    if [[ "$2" == *"/releases/tags/"* ]]; then printf 'Draft releases are not returned by the published-tag endpoint\\n' >&2; return 1; fi
    cat "$REMOTE_RELEASE_JSON"; return 0
  fi
  case "$2" in
    view) if [ "$RELEASE_PRESENT" = 1 ]; then
      if [[ "$*" == *"--json databaseId"* ]]; then printf '123456\\n'; else cat "$REMOTE_RELEASE_JSON"; fi
      return 0
      else printf 'release not found\\n' >&2; return 1; fi ;;
    create) RELEASE_PRESENT=1 ;;
    upload) if [ "$FAIL_UPLOAD" = 1 ]; then return 1; fi ;;
    edit) return 0 ;;
    *) printf 'Unexpected gh call\\n' >&2; return 99 ;;
  esac
}
node() {
  if [ "$1" != ../scripts/verify-release-assets.mjs ]; then return 99; fi
  shift
  "$NODE_EXECUTABLE" "$REAL_VERIFY_SCRIPT" "$@"
}
${releaseCommands(workflow)}
`);
    const bash = process.platform === 'win32'
      ? join(dirname(dirname(spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0])), 'bin', 'bash.exe')
      : 'bash';
    const result = spawnSync(bash, ['--noprofile', '--norc', script], {
      cwd: agent, encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory,
        AGENT_VERSION: version, AGENT_VERSION_TAG: version, GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'synthetic/repo',
        GITHUB_ENV: join(directory, 'github-env'), RUNNER_TEMP: directory, GH_TOKEN: 'synthetic-token',
        AUDIT_COMMAND_LOG: log, REMOTE_RELEASE_JSON: metadata, NODE_EXECUTABLE: process.execPath,
        REAL_VERIFY_SCRIPT: join(root, 'scripts', 'verify-release-assets.mjs'),
        TAG_PRESENT: tag ? '1' : '0', TAG_SHA: 'b'.repeat(40), RELEASE_PRESENT: release ? '1' : '0', FAIL_UPLOAD: failUpload ? '1' : '0' },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr, commands: await readFile(log, 'utf8') };
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(temporaryRoot) + sep), 'temporary cleanup stays in its named workspace directory');
    await rm(directory, { recursive: true, force: true });
  }
}

test('AUD-18 existing tag or published assets are never replaced by the current checkout', async () => {
  for (const state of [{ tag: true }, { release: true }, { tag: true, release: true }]) {
    const result = await fixture(state);
    assert.notEqual(result.status, 0, 'a used immutable version must be rejected');
    assert.doesNotMatch(result.commands, /gh release (upload|edit|create)/, 'rejection happens before release mutation');
  }
});

test('AUD-18 a new release remains draft until uploaded bytes match their recorded digests', async () => {
  const result = await fixture();
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.commands, /--clobber/);
  assert.match(result.commands, /gh release create[^\n]*--draft/);
  assert.match(result.commands, /gh api repos\/synthetic\/repo\/releases\/123456/);
  assert.match(result.commands, /gh release edit[^\n]*--draft=false/);
});

test('AUD-18 interrupted upload or mismatched remote digest cannot publish the draft', async () => {
  for (const state of [{ failUpload: true }, { badDigest: true }]) {
    const result = await fixture(state);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.commands, /gh release edit[^\n]*--draft=false/);
  }
});

test('R-A09 build metadata keeps tag identity while draft assets are read by release ID', async () => {
  const result = await fixture({ version: 'v9.0.0-rc.1+build.7' });
  assert.equal(result.status, 0, result.output);
  assert.match(result.commands, /git tag v9\.0\.0-rc\.1\+build\.7 /);
  assert.match(result.commands, /gh release view v9\.0\.0-rc\.1\+build\.7[^\n]*--json databaseId/);
  assert.match(result.commands, /gh api repos\/synthetic\/repo\/releases\/123456/);
  assert.match(result.commands, /gh release edit v9\.0\.0-rc\.1\+build\.7 --draft=false/);
});
