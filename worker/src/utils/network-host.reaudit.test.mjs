import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { validateWebsiteMonitorInput } = loader.load('worker/src/utils/website-monitor.ts');
const { validateWebhookUrl } = loader.load('worker/src/utils/webhook.ts');
const { validatePingTaskInput } = loader.load('worker/src/utils/ping-task.ts');

function outcomes(host) {
  const authority = host.includes(':') ? `[${host}]` : host;
  const task = { name: 'Synthetic target', all_clients: true, interval_sec: 120 };
  return {
    websiteHttp: validateWebsiteMonitorInput({ name: 'Synthetic', url: `https://${authority}` }).ok,
    websiteTcp: validateWebsiteMonitorInput({ name: 'Synthetic', method: 'TCP', url: `tcp://${authority}:443` }).ok,
    webhook: validateWebhookUrl(`https://${authority}/hook`).ok,
    pingIcmp: validatePingTaskInput({ ...task, type: 'icmp', target: host }).ok,
    pingTcp: validatePingTaskInput({ ...task, type: 'tcp', target: `${authority}:443` }).ok,
    pingHttp: validatePingTaskInput({ ...task, type: 'http', target: `https://${authority}` }).ok,
  };
}

for (const host of ['example.com', 'fda.gov', 'fc.example.com', 'fe80.example.com', 'ffmpeg.org']) {
  test(`R-D01 ordinary DNS host ${host} is accepted by website, webhook and Ping`, () => {
    assert.deepEqual(outcomes(host), {
      websiteHttp: true, websiteTcp: true, webhook: true,
      pingIcmp: true, pingTcp: true, pingHttp: true,
    });
  });
}

test('R-D01 public IPv6 remains usable in every target format', () => {
  assert.deepEqual(outcomes('2606:4700:4700::1111'), {
    websiteHttp: true, websiteTcp: true, webhook: true,
    pingIcmp: true, pingTcp: true, pingHttp: true,
  });
});

for (const host of ['fc00::1', 'fd00::1', 'fe80::1', '::1', '::ffff:127.0.0.1', '127.0.0.1', '10.0.0.1', '169.254.1.1', '2130706433', '0x7f000001']) {
  test(`R-D01 unsafe literal ${host} remains rejected by every target validator`, () => {
    assert.deepEqual(outcomes(host), {
      websiteHttp: false, websiteTcp: false, webhook: false,
      pingIcmp: false, pingTcp: false, pingHttp: false,
    });
  });
}
