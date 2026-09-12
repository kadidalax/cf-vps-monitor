import assert from 'node:assert/strict';
import test from 'node:test';
import * as fflate from 'fflate';
import { createWorkerLoader } from '../../test-support/worker-module.mjs';

const manifest = fflate.strToU8(JSON.stringify({ short: 'audit-fixture', name: 'Fixture', style: 'style.css' }));
function archive(extra = {}) {
  return fflate.zipSync({ 'cf-monitor-theme.json': manifest, 'style.css': fflate.strToU8('body { color: #123; }'), ...extra });
}

function parser() {
  let expanded = 0;
  let largestChunk = 0;
  class ObservedUnzip extends fflate.Unzip {
    constructor(onfile) {
      super(file => {
        const start = file.start;
        file.start = () => {
          const ondata = file.ondata;
          file.ondata = (error, data, final) => {
            expanded += data?.byteLength || 0;
            largestChunk = Math.max(largestChunk, data?.byteLength || 0);
            ondata(error, data, final);
          };
          start();
        };
        onfile(file);
      });
    }
  }
  const { parseThemeZip } = createWorkerLoader({ overrides: { fflate: {
    ...fflate, Unzip: ObservedUnzip,
    unzipSync: (...args) => {
      const files = fflate.unzipSync(...args);
      expanded += Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
      return files;
    },
  } } }).load('worker/src/utils/theme-package.ts');
  return { parseThemeZip, get expanded() { return expanded; }, get largestChunk() { return largestChunk; } };
}

function spoofSize(input, name, size) {
  const bytes = input.slice();
  const view = new DataView(bytes.buffer);
  let patched = 0;
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50 && signature !== 0x02014b50) continue;
    const local = signature === 0x04034b50;
    const length = view.getUint16(offset + (local ? 26 : 28), true);
    const begin = offset + (local ? 30 : 46);
    if (new TextDecoder().decode(bytes.subarray(begin, begin + length)) !== name) continue;
    view.setUint32(offset + (local ? 22 : 24), size, true);
    patched += 1;
  }
  assert.equal(patched, 2);
  return bytes;
}

test('AUD-12: declared oversized files are rejected before actual inflation', () => {
  const zip = archive({ 'assets/large.png': new Uint8Array(4 * 1024 * 1024) });
  assert.ok(zip.length < 8192, 'fixture is small and safe');
  const f = parser();
  assert.throws(() => f.parseThemeZip(zip), /too large/i);
  assert.ok(f.expanded < 64 * 1024, `parser inflated ${f.expanded} bytes before rejecting the declared size`);
});

test('AUD-12: forged small ZIP sizes cannot bypass the actual output budget', () => {
  const zip = spoofSize(archive({ 'assets/large.png': new Uint8Array(4 * 1024 * 1024) }), 'assets/large.png', 64);
  const f = parser();
  assert.throws(() => f.parseThemeZip(zip), /size|large|limit/i);
  assert.ok(f.expanded < 1024 * 1024, `stream produced ${f.expanded} bytes before rejecting a forged size`);
});

test('AUD-12: entry limits and forbidden file types are checked before inflation', () => {
  for (const extra of [
    { 'untrusted.js': new Uint8Array(100000) },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`assets/${index}.png`, new Uint8Array(10000)])),
  ]) {
    const f = parser();
    assert.throws(() => f.parseThemeZip(archive(extra)), /too many|not allowed/i);
    assert.equal(f.expanded, 0);
  }
});

test('AUD-12: a valid package still produces its manifest and exact assets', () => {
  const f = parser();
  const result = f.parseThemeZip(archive({ 'assets/icon.svg': fflate.strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>') }));
  assert.equal(result.theme.short, 'audit-fixture');
  assert.deepEqual(Array.from(result.assets, item => item.path).sort(), ['assets/icon.svg', 'style.css']);
  const css = result.assets.find(item => item.path === 'style.css');
  assert.equal(Buffer.from(css.content_base64, 'base64').toString(), 'body { color: #123; }');
});
