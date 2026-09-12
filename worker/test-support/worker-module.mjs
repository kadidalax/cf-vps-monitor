import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');

// Execute the production TS modules, substituting only external platform/DB I/O.
// This supports the repository's extensionless imports without changing production
// resolution or needing Cloudflare credentials in the Node test process.
export function createWorkerLoader({ db = {}, overrides = {}, globals = {}, expose = {} } = {}) {
  const cache = new Map();
  const database = { provider: 'audit-fixture' };
  const boundaryOverrides = {
    ...(db === null ? {} : {
    'worker/src/db/queries.ts': db,
    'worker/src/db/provider.ts': {
      getDatabase: () => database,
      withDatabase: async (_env, work) => work(database),
    },
    }),
    'cloudflare:sockets': { connect: () => { throw new Error('Unexpected TCP connection in test'); } },
    ...overrides,
  };
  const context = vm.createContext({
    console, Date, Math, Number, String, Boolean, JSON, Object, Array, Map, Set,
    Promise, Error, TypeError, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
    Request, Response, Headers, URL, URLSearchParams, AbortSignal, AbortController,
    ReadableStream, WritableStream, TransformStream, crypto: globalThis.crypto,
    atob, btoa, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    structuredClone, WebSocket: { READY_STATE_OPEN: 1, OPEN: 1, CLOSED: 3 },
    fetch: async () => { throw new Error('Unexpected network access in test'); },
    ...globals,
  });

  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.resolve(root, relative);
    const key = path.relative(root, filename).replaceAll(path.sep, '/');
    if (Object.hasOwn(boundaryOverrides, key)) return boundaryOverrides[key];
    if (cache.has(filename)) return cache.get(filename).exports;
    if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    const module = { exports: {} };
    cache.set(filename, module);
    let source = fs.readFileSync(filename, 'utf8');
    if (expose[key]?.length) source += `\nexport { ${expose[key].join(', ')} };\n`;
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function resolve(request) {
      if (Object.hasOwn(boundaryOverrides, request)) return boundaryOverrides[request];
      if (!request.startsWith('.')) return require(request);
      const candidate = path.resolve(path.dirname(filename), request);
      for (const full of [candidate, `${candidate}.ts`, `${candidate}.js`, path.join(candidate, 'index.ts')]) {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return load(full);
      }
      throw new Error(`Cannot resolve ${request} from ${filename}`);
    }
    const run = vm.runInContext(`(function (exports, module, require) {\n${compiled}\n})`, context, { filename });
    run(module.exports, module, resolve);
    return module.exports;
  }
  return { load, database };
}

export function createDurableState(initial = [], sockets = []) {
  const values = initial instanceof Map ? initial : new Map(initial);
  const jobs = [];
  const state = {
    getWebSockets: () => sockets,
    acceptWebSocket: socket => sockets.push(socket),
    waitUntil: promise => jobs.push(Promise.resolve(promise)),
    blockConcurrencyWhile: work => {
      const result = Promise.resolve().then(work);
      jobs.push(result);
      return result;
    },
    storage: {
      get: async key => Array.isArray(key)
        ? new Map(key.filter(item => values.has(item)).map(item => [item, structuredClone(values.get(item))]))
        : structuredClone(values.get(key)),
      put: async (key, value) => {
        if (typeof key === 'object') {
          for (const [name, entry] of Object.entries(key)) values.set(name, structuredClone(entry));
        } else values.set(key, structuredClone(value));
      },
      delete: async key => Array.isArray(key)
        ? key.reduce((n, item) => n + Number(values.delete(item)), 0)
        : values.delete(key),
      list: async ({ prefix = '', limit = Infinity } = {}) => new Map(
        [...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)
          .map(([key, value]) => [key, structuredClone(value)]),
      ),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
  };
  return {
    state, values, sockets,
    async drain() {
      while (jobs.length) await Promise.all(jobs.splice(0));
    },
  };
}

export function createSocket(initial, maxAttachmentBytes = 16384) {
  let attachment = structuredClone(initial);
  const messages = [];
  const ws = {
    readyState: 1,
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: value => {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxAttachmentBytes) {
        throw new Error('WebSocket attachment exceeds 16,384 bytes');
      }
      attachment = structuredClone(value);
    },
    send: value => messages.push(JSON.parse(value)),
    close: () => { ws.readyState = 3; },
  };
  return { ws, messages };
}
