import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Official PowerShell release asset digest, checked against its published hashes.
const powershell = Object.freeze({
  version: '7.6.6',
  url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/powershell-7.6.6-linux-x64.tar.gz',
  sha256: 'ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc',
});

// Workers Builds includes Go and Node, but does not promise PowerShell. Keep
// Windows installer/quoting tests in the deployment gate by supplying the tool.
export function prepareCloudflareVerificationEnv({
  root, env = process.env, platform = process.platform, arch = process.arch,
  run = spawnSync, release = powershell, log = console.log,
}) {
  const workersBuild = ['1', 'true'].includes(env.WORKERS_CI) || Boolean(env.WORKERS_CI_BUILD_UUID);
  if (platform !== 'linux' || !workersBuild) return env;

  const invoke = (command, args, timeout = 15000) => run(command, args, {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout,
  });
  const probeArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'];
  if (invoke('pwsh', probeArgs).status === 0) return env;
  if (arch !== 'x64') throw new Error('Workers Builds verification requires an installed PowerShell on this architecture.');

  const parent = join(root, 'worker', '.tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'powershell-'));
  const archive = join(directory, 'powershell.tar.gz');
  log(`Preparing PowerShell ${release.version} for the full Workers Builds verification.`);
  const download = invoke('curl', ['--fail', '--location', '--silent', '--show-error',
    '--max-time', '180', '--output', archive, release.url], 190000);
  if (download.error || download.status !== 0) {
    throw new Error('Could not download the pinned PowerShell release; deployment verification cannot continue.');
  }
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== release.sha256) {
    rmSync(archive, { force: true });
    throw new Error('PowerShell archive SHA256 mismatch; refusing to extract or execute it.');
  }
  const extracted = invoke('tar', ['--extract', '--gzip', '--file', archive,
    '--directory', directory, '--no-same-owner', '--no-same-permissions'], 60000);
  rmSync(archive, { force: true });
  if (extracted.error || extracted.status !== 0) throw new Error('Could not extract the verified PowerShell release.');
  const executable = join(directory, 'pwsh');
  chmodSync(executable, 0o755);
  const ready = invoke(executable, probeArgs);
  if (ready.error || ready.status !== 0) {
    throw new Error('The verified PowerShell release cannot run in this build image; check its native dependencies.');
  }
  return { ...env, PATH: `${directory}:${env.PATH || ''}` };
}
