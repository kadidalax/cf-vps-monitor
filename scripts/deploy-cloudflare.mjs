import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const sourceConfig = join(root, 'wrangler.toml');
const deployConfig = join(root, 'worker', '.tmp', 'wrangler-deploy.toml');
const requiredSecrets = ['JWT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'];
const deployArgs = process.argv.slice(2);
const isDryRun = deployArgs.includes('--dry-run');
const keepsExistingVars = deployArgs.includes('--keep-vars');
const wranglerDeployArgs = deployArgs.filter(arg => arg !== '--skip-migrations');

function runWrangler(args, options = {}) {
  return spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
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
  let generated = source.replace(/SUPABASE_URL\s*=\s*"[^"]*"/, `SUPABASE_URL = "${supabaseUrl}"`);
  generated = generated
    .replace('main = "worker/src/index.ts"', 'main = "../src/index.ts"')
    .replace('directory = "frontend/dist"', 'directory = "../../frontend/dist"');
  mkdirSync(dirname(deployConfig), { recursive: true });
  writeFileSync(deployConfig, generated);
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
}

writeDeployConfig();

if (isDryRun) {
  const deploy = runWrangler(['deploy', '--config', deployConfig, ...wranglerDeployArgs], { stdio: 'inherit' });
  process.exit(deploy.status ?? 1);
}

if (!keepsExistingVars) {
  checkSecrets();
}

console.log('Deploying Worker. Initialize the database after deploy at /db-init.');

const deploy = runWrangler(['deploy', '--config', deployConfig, ...wranglerDeployArgs], { stdio: 'inherit' });
if (deploy.status !== 0) process.exit(deploy.status ?? 1);
