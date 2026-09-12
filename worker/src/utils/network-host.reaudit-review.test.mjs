import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const loader = createWorkerLoader();
const { validateWebsiteMonitorInput } = loader.load('worker/src/utils/website-monitor.ts');
const { validateWebhookUrl } = loader.load('worker/src/utils/webhook.ts');
const { validatePingTaskInput } = loader.load('worker/src/utils/ping-task.ts');

function outcomes(host) {
  const authority = host.includes(':') ? `[${host}]` : host;
  const task = { name: 'Synthetic', all_clients: true, interval_sec: 120 };
  return {
    website: validateWebsiteMonitorInput({ name: 'Synthetic', url: `https://${authority}` }).ok,
    webhook: validateWebhookUrl(`https://${authority}/hook`).ok,
    icmp: validatePingTaskInput({ ...task, type: 'icmp', target: host }).ok,
    tcp: validatePingTaskInput({ ...task, type: 'tcp', target: `${authority}:443` }).ok,
    http: validatePingTaskInput({ ...task, type: 'http', target: `https://${authority}` }).ok,
  };
}

for (const host of [
  'fe90::1', 'fea0::1', 'febf::1',
  '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0000',
  '0000:0000:0000:0000:0000:ffff:7f00:1',
]) {
  test(`R-D01 review rejects the special IPv6 literal ${host} consistently`, () => {
    assert.deepEqual(outcomes(host), { website: false, webhook: false, icmp: false, tcp: false, http: false });
  });
}

for (const host of ['fe90.example.com', 'fda.gov', '2606:4700:0000:0000:0000:0000:0000:1111']) {
  test(`R-D01 review keeps ordinary/public host ${host} usable`, () => {
    assert.deepEqual(outcomes(host), { website: true, webhook: true, icmp: true, tcp: true, http: true });
  });
}
