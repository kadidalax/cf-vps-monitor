import { CF_MONITOR_REPOSITORY } from './projectLinks';

export type AgentInstallPlatform = 'unix' | 'windows';

export type AgentInstallOptions = {
  ghproxy: string;
  downloadProxy: string;
  installMode: 'auto' | 'system' | 'user';
  dir: string;
  serviceName: string;
  binaryUrl?: string;
  checksumUrl?: string;
  releaseTag?: string;
  scriptRef?: string;
  trafficResetDay: string;
  mountInclude: string;
  mountExclude: string;
  nicInclude: string;
  nicExclude: string;
};

export const defaultAgentInstallOptions: AgentInstallOptions = {
  ghproxy: '',
  downloadProxy: '',
  installMode: 'auto',
  dir: '',
  serviceName: '',
  binaryUrl: '',
  checksumUrl: '',
  releaseTag: '',
  scriptRef: '',
  trafficResetDay: '1',
  mountInclude: '',
  mountExclude: '',
  nicInclude: '',
  nicExclude: '',
};

export const CF_MONITOR_BRANCH = 'main';
export const CF_MONITOR_AGENT_SCRIPT_REF = `refs/heads/${CF_MONITOR_BRANCH}`;
export const CF_MONITOR_RELEASE_BASE = `https://github.com/${CF_MONITOR_REPOSITORY}/releases/latest/download`;
export const CF_MONITOR_AGENT_SCRIPT_BASE = `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/${CF_MONITOR_AGENT_SCRIPT_REF}/agent`;

function isLocalHttpHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
function serverUrlOrigin(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHttpHost(url.hostname))) && !url.username && !url.password && url.hostname) {
      return url.origin;
    }
  } catch {
    return '';
  }
  return '';
}

export function normalizeServerUrl(value: string, fallback: string) {
  return serverUrlOrigin(value) || serverUrlOrigin(fallback) || 'https://localhost';
}

function httpsDownloadUrl(value?: string | null) {
  const raw = value?.trim() || '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) {
      return url.toString();
    }
  } catch {
    return '';
  }
  return '';
}

function customAgentDownloadUrls(binaryValue?: string | null, checksumValue?: string | null) {
  const binaryUrl = httpsDownloadUrl(binaryValue);
  const checksumUrl = binaryUrl ? httpsDownloadUrl(checksumValue) : '';
  return binaryUrl && checksumUrl ? { binaryUrl, checksumUrl } : { binaryUrl: '', checksumUrl: '' };
}

function normalizeReleaseTag(value?: string | null) {
  const raw = value?.trim() || '';
  return /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw) ? raw : '';
}

export function normalizeProxyUrl(value: string, allowPath = true) {
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && url.hostname && !url.search && !url.hash) {
      const path = allowPath && url.pathname !== '/' ? url.pathname.replace(/\/+$/g, '') : '';
      return `${url.origin}${path}`;
    }
  } catch {
    return '';
  }
  return '';
}

export function proxiedUrl(url: string, ghproxy = '') {
  const proxy = normalizeProxyUrl(ghproxy);
  if (!proxy) return url;
  return `${proxy}/${url}`;
}

function normalizeScriptRef(scriptRef?: string | null) {
  const match = scriptRef?.trim().match(/^[a-f0-9]{7,40}$/i);
  return match ? match[0].toLowerCase() : CF_MONITOR_AGENT_SCRIPT_REF;
}

export function cfMonitorAgentScriptRefFromRevision(revision?: string | null) {
  const scriptRef = normalizeScriptRef(revision);
  return scriptRef === CF_MONITOR_AGENT_SCRIPT_REF ? '' : scriptRef;
}

export function cfMonitorAgentScriptUrl(
  scriptFile: 'install.sh' | 'install-linux.sh' | 'install-windows.ps1',
  ghproxy = '',
  releaseTag = '',
  scriptRef = '',
) {
  const ref = normalizeScriptRef(scriptRef);
  const tag = normalizeReleaseTag(releaseTag);
  const base = tag
      ? `https://github.com/${CF_MONITOR_REPOSITORY}/releases/download/${tag}`
      : `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/${ref}/agent`;
  return proxiedUrl(`${base}/${scriptFile}`, ghproxy);
}

export function cfMonitorAgentBinaryUrl(platform: AgentInstallPlatform, ghproxy = '') {
  const file = platform === 'windows'
    ? 'cf-vps-monitor-agent-windows-amd64.exe'
    : 'cf-vps-monitor-agent-linux-amd64';
  return proxiedUrl(`${CF_MONITOR_RELEASE_BASE}/${file}`, ghproxy);
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function psQuote(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function normalizeTrafficResetDay(value: string) {
  const day = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(day)) return '1';
  return String(Math.min(31, Math.max(1, day)));
}

function normalizeInstanceId(value?: string) {
  const cleaned = (value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'default').slice(0, 48);
}

function shPipe(downloadCommand: string, args: string[]) {
  return `${downloadCommand} | sh -s -- ${args.map(shellQuote).join(' ')}`;
}

export function buildAgentInstallCommand({
  platform,
  serverUrl,
  token,
  options,
  instanceId,
  nodeName,
}: {
  platform: AgentInstallPlatform;
  serverUrl: string;
  token: string;
  options: AgentInstallOptions;
  instanceId?: string;
  nodeName?: string;
}) {
  const ghproxy = normalizeProxyUrl(options.ghproxy);
  const downloadProxy = normalizeProxyUrl(options.downloadProxy, false);
  const { binaryUrl, checksumUrl } = customAgentDownloadUrls(options.binaryUrl, options.checksumUrl);
  const releaseTag = normalizeReleaseTag(options.releaseTag);
  const scriptRef = options.scriptRef?.trim();
  const installMode = ['system', 'user'].includes(options.installMode) ? options.installMode : '';
  const dir = options.dir.trim();
  const serviceName = options.serviceName.trim();
  const effectiveInstanceId = normalizeInstanceId(instanceId || nodeName);
  const effectiveNodeName = nodeName?.trim();
  const mountInclude = options.mountInclude.trim();
  const mountExclude = options.mountExclude.trim();
  const nicInclude = options.nicInclude.trim();
  const nicExclude = options.nicExclude.trim();
  const trafficResetDay = normalizeTrafficResetDay(options.trafficResetDay);

  switch (platform) {
    case 'unix': {
      const args = ['-s', serverUrl, '-t', token || '<TOKEN>'];
      if (trafficResetDay !== '1') args.push('-r', trafficResetDay);
      if (effectiveNodeName) args.push('-n', effectiveNodeName);
      args.push('-i', effectiveInstanceId);
      if (installMode) args.push('--install-mode', installMode);
      if (binaryUrl) args.push('--binary-url', binaryUrl);
      if (checksumUrl) args.push('--checksum-url', checksumUrl);
      if (releaseTag && !binaryUrl) args.push('--release-tag', releaseTag);
      if (ghproxy) args.push('--install-ghproxy', ghproxy);
      if (downloadProxy) args.push('--proxy', downloadProxy);
      if (dir) args.push('--install-dir', dir);
      if (serviceName) args.push('--service-name', serviceName);
      if (mountInclude) args.push('--mount-include', mountInclude);
      if (mountExclude) args.push('--mount-exclude', mountExclude);
      if (nicInclude) args.push('--nic-include', nicInclude);
      if (nicExclude) args.push('--nic-exclude', nicExclude);
      return shPipe(
        `wget -qO- ${shellQuote(cfMonitorAgentScriptUrl('install.sh', ghproxy, releaseTag, scriptRef))}`,
        args,
      );
    }
    case 'windows': {
      const args = ['-s', serverUrl, '-t', token || '<TOKEN>'];
      if (trafficResetDay !== '1') args.push('-r', trafficResetDay);
      if (effectiveNodeName) args.push('-n', effectiveNodeName);
      args.push('-i', effectiveInstanceId);
      if (binaryUrl) args.push('-BinaryUrl', binaryUrl);
      if (checksumUrl) args.push('-ChecksumUrl', checksumUrl);
      if (releaseTag && !binaryUrl) args.push('-ReleaseTag', releaseTag);
      if (ghproxy) args.push('-InstallGhproxy', ghproxy);
      if (downloadProxy) args.push('-Proxy', downloadProxy);
      if (dir) args.push('-InstallDir', dir);
      if (serviceName) args.push('-ServiceName', serviceName);
      if (mountInclude) args.push('-MountInclude', mountInclude);
      if (mountExclude) args.push('-MountExclude', mountExclude);
      if (nicInclude) args.push('-NicInclude', nicInclude);
      if (nicExclude) args.push('-NicExclude', nicExclude);
      return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
        `"iwr ${psQuote(cfMonitorAgentScriptUrl('install-windows.ps1', ghproxy, releaseTag, scriptRef))} -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\\install-windows.ps1' ${args.map((arg, index) => index % 2 === 0 ? arg : psQuote(arg)).join(' ')}"`;
    }
    default:
      return '';
  }
}
export function buildAgentUninstallAllCommand({
  platform,
  ghproxy = '',
  scriptRef = '',
}: {
  platform: AgentInstallPlatform;
  serverUrl?: string;
  ghproxy?: string;
  scriptRef?: string;
}) {
  const proxy = normalizeProxyUrl(ghproxy);
  const scriptUrl = (file: 'install.sh' | 'install-windows.ps1') =>
    cfMonitorAgentScriptUrl(file, proxy, '', scriptRef);
  switch (platform) {
    case 'windows':
      return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
        `"iwr ${psQuote(scriptUrl('install-windows.ps1'))} -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\\install-windows.ps1' -UninstallAll -Yes"`;
    case 'unix':
    default:
      return shPipe(
        `wget -qO- ${shellQuote(scriptUrl('install.sh'))}`,
        ['--uninstall-all', '--yes', ...(proxy ? ['--install-ghproxy', proxy] : [])],
      );
  }
}
