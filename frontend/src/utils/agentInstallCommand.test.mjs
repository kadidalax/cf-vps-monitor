import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = await mkdtemp(join(tmpdir(), 'cf-monitor-agent-command-'));
const projectLinksSource = await readFile(new URL('./projectLinks.ts', import.meta.url), 'utf8');
const commandSource = await readFile(new URL('./agentInstallCommand.ts', import.meta.url), 'utf8');
await writeFile(join(tmp, 'projectLinks.ts'), projectLinksSource);
await writeFile(join(tmp, 'agentInstallCommand.ts'), commandSource.replace("from './projectLinks'", "from './projectLinks.ts'"));

const { buildAgentInstallCommand, defaultAgentInstallOptions } = await import(pathToFileURL(join(tmp, 'agentInstallCommand.ts')).href);
const { CF_MONITOR_REPOSITORY } = await import(pathToFileURL(join(tmp, 'projectLinks.ts')).href);

const base = {
  serverUrl: 'https://panel.example',
  token: 'token123',
  options: { ...defaultAgentInstallOptions },
  instanceId: '33bc95df-513d-41be-8d98-30979fb17029',
  nodeName: 'node-123',
};

assert.equal(
  buildAgentInstallCommand({ platform: 'linux', ...base }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install-linux.sh' | sudo bash -s -- '-s' 'https://panel.example' '-t' 'token123' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029'`,
);

assert.equal(
  buildAgentInstallCommand({
    platform: 'linux',
    ...base,
    options: { ...defaultAgentInstallOptions, trafficResetDay: '15', downloadProxy: '127.0.0.1:10808' },
  }),
  `wget -qO- 'https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/main/agent/install-linux.sh' | sudo bash -s -- '-s' 'https://panel.example' '-t' 'token123' '-r' '15' '-n' 'node-123' '-i' '33bc95df-513d-41be-8d98-30979fb17029' '--proxy' 'http://127.0.0.1:10808'`,
);

await rm(tmp, { recursive: true, force: true });
