import test from 'node:test';
import assert from 'node:assert/strict';
import { productionEffect, productionModule } from './helpers/production-module.mjs';
import { normalizeLiveDataResponse } from '../src/utils/liveDataResponse.ts';
import { normalizePublicClients, mergePublicClientPatch } from '../src/utils/publicClients.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));

function metadataFixture(includeHidden = false) {
  const requests = [];
  const state = { clients: undefined, settingsReads: 0 };
  let notify;
  const scope = productionModule('src/contexts/LiveDataContext.tsx').createLiveSnapshotScope();
  const cleanup = productionEffect('src/contexts/LiveDataContext.tsx', 'const applyBootstrap', {
    authLoading: false, enabled: true, viewer: true, includeHidden,
    window: new EventTarget(), LIVE_POLL_SETTINGS_UPDATED_EVENT: 'synthetic-settings',
    liveScopeRef: { current: scope }, pollConfigRef: { current: {} }, DEFAULT_LIVE_POLL_CONFIG: {},
    normalizePublicSettings: value => value, setCachedPublicSettings() {}, normalizeLivePollConfig: () => ({}),
    normalizeLiveDataResponse, rememberInitialLiveMetadataVersion() {}, setLoading() {}, setError() {}, setLiveData() {},
    mergePublicClientPatch,
    setClientMetadata: update => { state.clients = typeof update === 'function' ? update(state.clients) : update; },
    fetchPublicBootstrap: options => new Promise((resolve, reject) => requests.push({ options, resolve, reject })),
    fetchPublicSettings: async () => { state.settingsReads += 1; return {}; },
    subscribePublicDataUpdated: callback => { notify = callback; return () => {}; },
  })();
  return {
    state, requests, notify: detail => notify(detail), cleanup,
    async reply(index, clients) {
      requests[index].resolve({ clients: normalizePublicClients(clients, { includeHidden }) });
      await settle();
    },
  };
}

for (const includeHidden of [false, true]) {
  test(`metadata refresh preserves confirmed ${includeHidden ? 'authorized' : 'public'} rows until a valid replacement`, async () => {
    const fixture = metadataFixture(includeHidden);
    try {
      await fixture.reply(0, [{ uuid: 'node-b', name: 'Second', sort_order: 1 }, { uuid: 'node-a', name: 'First', sort_order: 0 }]);
      const confirmed = fixture.state.clients;
      fixture.notify({ force: true });
      assert.equal(fixture.state.clients, confirmed, 'a pending refresh must not blank the current node cards');
      assert.equal(fixture.requests.length, 2, 'the existing single refresh is sufficient');
      await fixture.reply(1, [{ uuid: 'node-c', name: 'Replacement' }]);
      assert.deepEqual(fixture.state.clients.map(client => client.uuid), ['node-c']);

      fixture.notify({ force: true });
      await fixture.reply(2, []);
      assert.deepEqual(fixture.state.clients, [], 'a successful empty list must clear the old cards');
    } finally { fixture.cleanup(); }
  });
}

test('failed metadata refresh retains the last confirmed rows and applies intervening removals', async () => {
  const fixture = metadataFixture();
  try {
    await fixture.reply(0, [{ uuid: 'node-a', name: 'Keep' }, { uuid: 'node-b', name: 'Remove' }]);
    fixture.notify({ force: true });
    fixture.notify({ clients: { remove: ['node-b'], upsert: [{ uuid: 'node-a', name: 'Latest' }] } });
    fixture.requests[1].reject(new Error('Synthetic disconnected network'));
    await settle();
    assert.deepEqual(fixture.state.clients?.map(client => [client.uuid, client.name]), [['node-a', 'Latest']],
      'a failed full read cannot erase confirmed rows or undo an explicit removal');
    assert.equal(fixture.requests.length, 2, 'preserving display data must not start more metadata reads');
    assert.equal(fixture.state.settingsReads, 1, 'the existing settings fallback remains bounded');
  } finally { fixture.cleanup(); }
});

test('a patch during the first metadata read does not invent a confirmed full list', async () => {
  const fixture = metadataFixture();
  try {
    fixture.notify({ clients: { upsert: [{ uuid: 'node-a', name: 'Patched' }] } });
    assert.equal(fixture.state.clients, undefined);
    await fixture.reply(0, [{ uuid: 'node-a', name: 'Old' }, { uuid: 'node-b', name: 'Other' }]);
    assert.deepEqual(fixture.state.clients.map(client => client.name), ['Other', 'Patched']);
  } finally { fixture.cleanup(); }
});

for (const field of ['clients', 'nodes']) {
  for (const includeHidden of [false, true]) {
    test(`malformed bootstrap ${field} cannot confirm an empty ${includeHidden ? 'authorized' : 'public'} list`, async () => {
      let payload;
      let reads = 0;
      const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
        fetch: async () => { reads += 1; return Response.json(payload); },
      });
      const malformed = [null, 'not-a-list', 0, false, {}, { error: 'Synthetic metadata failure' }, { data: null }];
      for (const value of malformed) {
        payload = { [field]: value };
        await assert.rejects(bootstrap.fetchPublicBootstrap({ includeHidden }), /Invalid public bootstrap/,
          `${field}=${JSON.stringify(value)} is a failed read, not a confirmed empty list`);
        assert.equal(bootstrap.getCachedPublicBootstrap(), null, 'invalid metadata must never replace the public cache');
      }
      assert.equal(reads, malformed.length, 'validation must not introduce another network request');
    });
  }
}

for (const includeHidden of [false, true]) {
  test(`bootstrap preserves missing lists and valid ${includeHidden ? 'authorized' : 'public'} list containers`, async () => {
    let payload = {};
    const bootstrap = productionModule('src/utils/publicBootstrap.ts', {}, {
      fetch: async () => Response.json(payload),
    });
    const missing = await bootstrap.fetchPublicBootstrap({ includeHidden });
    assert.equal(missing.clients, undefined);
    assert.equal(missing.nodes, undefined);

    const rows = [{ uuid: 'visible', sort_order: 0 }, { uuid: 'hidden', hidden: true, sort_order: 1 }];
    for (const container of [rows, { data: rows }, [], { data: [] }]) {
      payload = { clients: container, nodes: container };
      const normalized = await bootstrap.fetchPublicBootstrap({ includeHidden });
      const expected = container === rows || container.data === rows
        ? includeHidden ? ['visible', 'hidden'] : ['visible']
        : [];
      assert.deepEqual(Array.from(normalized.clients, client => client.uuid), expected);
      assert.deepEqual(Array.from(normalized.nodes, client => client.uuid), expected);
    }
  });
}
