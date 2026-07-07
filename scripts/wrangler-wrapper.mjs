#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const managedDeploy = join(root, 'scripts', 'deploy-cloudflare.mjs');
const realWrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function resolveWrapperCommand(args) {
  if (args[0] === 'deploy') {
    return { type: 'managed-deploy', mode: 'deploy', args: args.slice(1) };
  }
  if (args[0] === 'versions' && args[1] === 'upload') {
    return { type: 'managed-deploy', mode: 'versions-upload', args: args.slice(2) };
  }
  return { type: 'passthrough', args };
}

function run() {
  const command = resolveWrapperCommand(process.argv.slice(2));
  const child = command.type === 'managed-deploy'
    ? spawnSync(process.execPath, [managedDeploy, ...command.args], {
      cwd: root,
      env: { ...process.env, CF_MONITOR_DEPLOY_COMMAND: command.mode },
      stdio: 'inherit',
    })
    : spawnSync(process.execPath, [realWrangler, ...command.args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
  process.exit(child.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
