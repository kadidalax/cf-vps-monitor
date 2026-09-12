export const websiteConfiguration = [
  {
    id: 7, name: 'Synthetic HTTP', url: 'https://example.com/', method: 'GET',
    expected_status_min: 200, expected_status_max: 299, interval_sec: 120,
    timeout_sec: 10, grace_period_sec: 180, enabled: true, hidden: false,
    hide_url: false, agent_probe_mode: 'off', agent_probe_clients: [],
    agent_probe_limit: 3, agent_probe_status_enabled: false, sort_order: 3,
  },
  {
    id: 9, name: 'Synthetic HEAD', url: 'https://example.org/status', method: 'HEAD',
    expected_status_min: 204, expected_status_max: 399, interval_sec: 300,
    timeout_sec: 20, grace_period_sec: 600, enabled: false, hidden: true,
    hide_url: true, agent_probe_mode: 'selected', agent_probe_clients: ['node-a', 'node-b'],
    agent_probe_limit: 2, agent_probe_status_enabled: true, sort_order: 1,
  },
  {
    id: 11, name: 'Synthetic TCP', url: 'tcp://example.net:443', method: 'TCP',
    expected_status_min: 200, expected_status_max: 399, interval_sec: 60,
    timeout_sec: 3, grace_period_sec: 60, enabled: true, hidden: false,
    hide_url: true, agent_probe_mode: 'country_auto', agent_probe_clients: [],
    agent_probe_limit: 4, agent_probe_status_enabled: true, sort_order: 2,
  },
];

export function configurationOnly(rows) {
  return rows.map(row => Object.fromEntries(Object.keys(websiteConfiguration[0]).map(key => [key, row[key]])))
    .sort((left, right) => left.id - right.id);
}

export function makeWebsiteBackup() {
  return {
    schema: 'cf-monitor.backup', version: '2.0.0', scope: 'configuration',
    timestamp: '2026-09-06T00:00:00.000Z',
    clients: [{ uuid: 'node-a', name: 'Synthetic A' }, { uuid: 'node-b', name: 'Synthetic B' }],
    website_monitors: structuredClone(websiteConfiguration),
  };
}
