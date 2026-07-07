import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const sourceConfig = join(root, 'wrangler.toml');
const deployConfig = join(root, 'worker', '.tmp', 'wrangler-deploy.toml');
const deploySecretsFile = join(root, 'worker', '.tmp', 'wrangler-secrets.json');
const requiredSecrets = ['JWT_SECRET'];
const supabaseSecretNames = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const deployArgs = process.argv.slice(2);
const isDryRun = deployArgs.includes('--dry-run');
const keepsExistingVars = deployArgs.includes('--keep-vars');
const wranglerDeployArgs = deployArgs.filter(arg => arg !== '--skip-migrations');
const deployCommand = process.env.CF_MONITOR_DEPLOY_COMMAND === 'versions-upload'
  ? ['versions', 'upload']
  : ['deploy'];

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

function resolveSupabaseUrl({ allowDryRunFallback = false } = {}) {
  const envUrl = process.env.SUPABASE_URL?.trim();
  const source = readFileSync(sourceConfig, 'utf8');
  const configUrl = source.match(/SUPABASE_URL\s*=\s*"([^"]+)"/i)?.[1]?.trim() || '';
  const url = envUrl || configUrl;
  if (!url || /PROJECT_REF/i.test(url)) {
    if (allowDryRunFallback) return 'https://dry-run.supabase.co';
    fail('SUPABASE_URL must be set to a real Supabase project URL before deploying.');
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
  let generated = source.replace(/SUPABASE_URL\s*=\s*"[^"]*"/, `SUPABASE_URL = "${supabaseUrl}"`);
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
  const result = runWrangler(['secret', 'list', '--config', deployConfig]);
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
