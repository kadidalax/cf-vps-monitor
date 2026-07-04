import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

const {
  clearCachedPublicBootstrap,
  fetchPublicBootstrap,
  getCachedPublicBootstrap,
  patchCachedPublicBootstrapClients,
} = await import('./publicBootstrap.ts');

const clients = [
  { uuid: 'hong', name: '香港123', sort_order: 1 },
  { uuid: 'lxc', name: 'test2-LXC', sort_order: 2 },
  { uuid: 'test', name: '测试服务器1', sort_order: 3 },
];

globalThis.fetch = async () => new Response(JSON.stringify({ clients }), { status: 200 });

clearCachedPublicBootstrap();
await fetchPublicBootstrap({ cacheBust: true });
patchCachedPublicBootstrapClients({
  clients: {
    upsert: [
      { uuid: 'test', name: '测试服务器1' },
      { uuid: 'lxc', name: 'test2-LXC' },
      { uuid: 'hong', name: '香港123' },
    ],
  },
});

assert.deepEqual(
  getCachedPublicBootstrap()?.clients?.map((client) => `${client.sort_order}:${client.name}`),
  ['1:香港123', '2:test2-LXC', '3:测试服务器1'],
);
