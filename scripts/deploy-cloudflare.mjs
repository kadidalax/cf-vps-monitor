import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareCloudflareVerificationEnv } from './cloudflare-build-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const sourceConfig = join(root, 'wrangler.toml');
const deployConfig = join(root, 'worker', '.tmp', 'wrangler-deploy.toml');
const deploySecretsFile = join(root, 'worker', '.tmp', 'wrangler-secrets.json');
const requiredSecrets = ['JWT_SECRET'];
const supabaseSecretNames = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const deployArgs = process.argv.slice(2);
const isDryRun = deployArgs.includes('--dry-run');
const isWorkersBuild = process.env.WORKERS_CI === '1';
const keepsExistingVars = deployArgs.includes('--keep-vars');
const wranglerDeployArgs = deployArgs.filter(arg => arg !== '--skip-migrations');
const deployCommand = process.env.CF_MONITOR_DEPLOY_COMMAND === 'versions-upload'
  ? ['versions', 'upload']
  : ['deploy'];

// This is also the entrypoint used by the Wrangler wrapper and Workers Builds.
// Reuse the same commit's GitHub verification in Workers Builds. Local deploys
// still verify locally. Neither path may publish before its checks pass.
if (!isDryRun && isWorkersBuild) {
  const verifiedCommit = currentGitCommit();
  const ci = spawnSync(process.execPath, [join(root, 'scripts', 'github-ci-gate.mjs')], {
    cwd: root, env: process.env, stdio: 'inherit', windowsHide: true,
  });
  if (ci.status !== 0) fail('Deployment stopped: GitHub CI for this commit did not pass.');

  console.log('GitHub CI passed. Building deployment assets without repeating the test suite.');
  const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root, env: process.env, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (build.status !== 0) fail('Deployment stopped: build did not pass.');
  const unchanged = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root, windowsHide: true });
  if (!verifiedCommit || currentGitCommit() !== verifiedCommit || unchanged.status !== 0) {
    fail('Deployment stopped: source changed after GitHub CI verification.');
  }
} else if (!isDryRun) {
  let verificationEnv;
  try {
    verificationEnv = prepareCloudflareVerificationEnv({ root });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const verification = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'verify'], {
    cwd: root,
    env: verificationEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (verification.status !== 0) fail('Deployment stopped: full verification did not pass.');
}

function runWrangler(args, options = {}) {
  return spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
}

function currentGitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * 解析本次部署的目标 Worker 名。优先级：--name 参数 > CF_WORKER_NAME 环境变量 > wrangler.toml 的 name。
 *
 * Workers Builds 文档保证 CI / WORKERS_CI / WORKERS_CI_BUILD_UUID，不保证 Worker 名，
 * 因此当实际 Worker 名与仓库默认名不同时，
 * 必须由部署命令的 --name 或 CF_WORKER_NAME 指定。
 */
function resolveWorkerName() {
  const flagIndex = deployArgs.indexOf('--name');
  if (flagIndex >= 0 && deployArgs[flagIndex + 1] && !deployArgs[flagIndex + 1].startsWith('-')) {
    return { name: deployArgs[flagIndex + 1].trim(), fromEnv: false };
  }
  const inline = deployArgs.find(arg => arg.startsWith('--name='));
  if (inline) return { name: inline.slice('--name='.length).trim(), fromEnv: false };
  const envName = process.env.CF_WORKER_NAME?.trim();
  if (envName) return { name: envName, fromEnv: true };
  const source = readFileSync(sourceConfig, 'utf8');
  return { name: source.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]?.trim() || '', fromEnv: false };
}

/** 目标 Worker 是否已经部署过。已存在 ⇒ 这是更新部署，线上变量已配置好。 */
function workerAlreadyDeployed(name) {
  if (!name) return false;
  return runWrangler(['secret', 'list', '--name', name]).status === 0;
}

const { name: workerName, fromEnv: workerNameFromEnv } = resolveWorkerName();
/** true 表示复用线上已有的 SUPABASE_URL：从生成的配置里省略它，并强制 --keep-vars。 */
let reuseDeployedSupabaseUrl = false;

function resolveSupabaseUrl({ allowDryRunFallback = false } = {}) {
  const envUrl = process.env.SUPABASE_URL?.trim();
  const source = readFileSync(sourceConfig, 'utf8');
  const configUrl = source.match(/SUPABASE_URL\s*=\s*"([^"]+)"/i)?.[1]?.trim() || '';
  const url = envUrl || configUrl;
  if (!url || /PROJECT_REF/i.test(url)) {
    if (allowDryRunFallback) return 'https://dry-run.supabase.co';
    // 更新部署：目标 Worker 已存在，线上已有正确的 SUPABASE_URL。
    // 从生成的配置里省略该变量并强制 --keep-vars，让 Cloudflare 保留线上原值，
    // 这样 CI（Workers Builds）无需把 Supabase 地址配进构建环境或提交进公开仓库。
    if (workerAlreadyDeployed(workerName)) {
      reuseDeployedSupabaseUrl = true;
      console.log(`SUPABASE_URL not provided; reusing the value already deployed on Worker "${workerName}".`);
      return null;
    }
    fail([
      'SUPABASE_URL must be set to a real Supabase project URL before deploying.',
      `Worker "${workerName || '(unnamed)'}" has not been deployed yet, so there is no existing value to reuse.`,
      '',
      '- New deployment: set SUPABASE_URL locally, or in Workers Builds > Settings > Variables and Secrets.',
      '- Updating an existing Worker: its real name differs from the one above. Pass',
      '  `--name <worker>` in the deploy command, or set CF_WORKER_NAME, and the deployed',
      '  SUPABASE_URL will be reused automatically.',
    ].join('\n'));
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
    fail('SUPABASE_URL must be set to a real Supabase project URL before deploying.');
  }
  return url.replace(/\/$/, '');
}

function writeDeployConfig() {
  const source = readFileSync(sourceConfig, 'utf8');
  const supabaseUrl = resolveSupabaseUrl({ allowDryRunFallback: isDryRun });
  const commit = currentGitCommit();
  let generated = supabaseUrl === null
    // 整行删掉，配置里不含该变量 + --keep-vars ⇒ Cloudflare 保留线上已有值
    ? source.replace(/^[ \t]*SUPABASE_URL[ \t]*=[ \t]*"[^"]*"[ \t]*\r?\n/m, '')
    : source.replace(/SUPABASE_URL\s*=\s*"[^"]*"/, `SUPABASE_URL = "${supabaseUrl}"`);
  generated = /\nCURRENT_GIT_COMMIT\s*=/.test(generated)
    ? generated.replace(/CURRENT_GIT_COMMIT\s*=\s*"[^"]*"/, `CURRENT_GIT_COMMIT = "${commit}"`)
    : generated.replace(/(\[vars\]\s*)/, `$1\nCURRENT_GIT_COMMIT = "${commit}"\n`);
  generated = generated
    .replace('main = "worker/src/index.ts"', 'main = "../src/index.ts"')
    .replace('directory = "frontend/dist"', 'directory = "../../frontend/dist"');
  mkdirSync(dirname(deployConfig), { recursive: true });
  writeFileSync(deployConfig, generated);
}

function writeDeploySecretsFile() {
  const secrets = Object.fromEntries(
    [...requiredSecrets, ...supabaseSecretNames]
      .map(name => [name, process.env[name]?.trim() || ''])
      .filter(([, value]) => value),
  );
  if (Object.keys(secrets).length === 0) return false;

  const missing = requiredSecrets.filter(name => !secrets[name]);
  if (missing.length) {
    fail(`Missing required Worker secrets in build environment: ${missing.join(', ')}`);
  }
  if (!supabaseSecretNames.some(name => secrets[name])) {
    fail('Missing required Worker secret in build environment: SUPABASE_SECRET_KEY');
  }

  mkdirSync(dirname(deploySecretsFile), { recursive: true });
  writeFileSync(deploySecretsFile, JSON.stringify(secrets), { mode: 0o600 });
  return true;
}

function checkSecrets() {
  // 按实际目标 Worker 查询，而不是按配置里的 name——CI 可能用 --name 覆盖了目标。
  const result = runWrangler(['secret', 'list', '--name', workerName]);
  if (result.status !== 0) {
    fail(`Could not list Worker secrets. Set them first with: npx wrangler secret put JWT_SECRET\n${result.stderr || result.stdout}`);
  }

  let secrets;
  try {
    secrets = JSON.parse(result.stdout);
  } catch {
    fail(`Could not parse Worker secret list.\n${result.stdout}`);
  }

  const names = new Set(secrets.map(secret => secret.name));
  const missing = requiredSecrets.filter(name => !names.has(name));
  if (missing.length) {
    fail(`Missing required Worker secrets: ${missing.join(', ')}\nSet them with: npx wrangler secret put <NAME>`);
  }
  if (!supabaseSecretNames.some(name => names.has(name))) {
    fail('Missing required Worker secret: SUPABASE_SECRET_KEY\nSet it with: npx wrangler secret put SUPABASE_SECRET_KEY');
  }
}

function buildWranglerDeployArgs() {
  const args = [...deployCommand, '--config', deployConfig, ...wranglerDeployArgs];
  // 名字来自 CF_WORKER_NAME 时要显式传给 wrangler，否则它会用配置里的默认名。
  if (workerNameFromEnv) args.push('--name', workerName);
  // 复用线上 SUPABASE_URL 时必须带 --keep-vars，否则 Cloudflare 会删掉配置里没有的变量。
  if (reuseDeployedSupabaseUrl && !wranglerDeployArgs.includes('--keep-vars')) args.push('--keep-vars');
  if (hasDeploySecretsFile) args.push('--secrets-file', deploySecretsFile);
  return args;
}

writeDeployConfig();
const hasDeploySecretsFile = writeDeploySecretsFile();

if (isDryRun) {
  const args = buildWranglerDeployArgs();
  const deploy = runWrangler(args, { stdio: 'inherit' });
  if (hasDeploySecretsFile) rmSync(deploySecretsFile, { force: true });
  process.exit(deploy.status ?? 1);
}

if (!keepsExistingVars && !hasDeploySecretsFile) {
  checkSecrets();
}

console.log('Deploying Worker. Initialize the database after deploy at /db-init.');

const args = buildWranglerDeployArgs();
const deploy = runWrangler(args, { stdio: 'inherit' });
if (hasDeploySecretsFile) rmSync(deploySecretsFile, { force: true });
if (deploy.status !== 0) process.exit(deploy.status ?? 1);
