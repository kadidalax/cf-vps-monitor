import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const number = '(0|[1-9][0-9]*)';
const prerelease = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*)';
const versionPattern = new RegExp(`^v${number}\\.${number}\\.${number}(-${prerelease}(\\.${prerelease})*)?(\\+[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*)?$`);

export function validateReleaseVersion(version) {
  assert.equal(typeof version, 'string', 'agent release version is required');
  assert.ok(version.length <= 128 && !/[^A-Za-z0-9.+-]/.test(version) &&
    !version.endsWith('.lock') && versionPattern.test(version),
  'Agent version must be a Git-ref-safe vSemVer tag (optional -prerelease/+build, at most 128 ASCII characters).');
  return version;
}

export async function verifyReleaseAssets(version, commit, directory, release) {
  validateReleaseVersion(version);
  assert.equal(release.tag_name, version, 'release tag identity does not match');
  assert.equal(release.target_commitish, commit, 'release source commit does not match');
  assert.equal(release.draft, true, 'assets must be verified before publication');
  const files = (await readdir(directory, { withFileTypes: true })).filter(item => item.isFile()).map(item => item.name).sort();
  assert.ok(files.length > 0, 'release has no local artifacts');
  assert.ok(Array.isArray(release.assets), 'release assets are missing');
  const assets = new Map(release.assets.map(asset => [asset.name, asset]));
  assert.equal(assets.size, release.assets.length, 'duplicate remote asset names');
  assert.deepEqual([...assets.keys()].sort(), files, 'remote artifact set is incomplete or unexpected');
  for (const name of files) {
    const contents = await readFile(join(directory, name));
    const expected = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
    assert.equal(assets.get(name).size, contents.length, `asset size mismatch: ${name}`);
    assert.equal(assets.get(name).digest, expected, `asset digest mismatch: ${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--version-path') {
      assert.equal(args.length, 2, '--version-path requires one version tag');
      console.log(encodeURIComponent(validateReleaseVersion(args[1])));
    } else {
      const [version, commit, directory, metadata] = args;
      await verifyReleaseAssets(version, commit, directory, JSON.parse(await readFile(metadata, 'utf8')));
      console.log('Release artifact identities and digests verified.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
