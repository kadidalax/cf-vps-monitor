import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Miniflare } from 'miniflare';

// Resolve through the real consumer, so a hoisted, unused patched copy cannot
// hide an older Sharp/native library still loaded by Miniflare.
const fromMiniflare = createRequire(import.meta.resolve('miniflare'));
const sharp = fromMiniflare('sharp');
const { gte } = createRequire(fromMiniflare.resolve('sharp'))('semver');

test('V-S01 Miniflare loads a Sharp release patched for GHSA-rgj7-g3m4-5g8c', t => {
  t.diagnostic(`loaded Sharp ${sharp.versions.sharp}, libheif ${sharp.versions.heif}, libvips ${sharp.versions.vips}`);
  assert.ok(gte(sharp.versions.sharp, '0.35.4'), 'the loaded Sharp release must include the upstream security patch');
});

test('V-S01 the actual loaded native libheif includes the advisory fix', () => {
  assert.ok(gte(sharp.versions.heif, '1.23.2'), 'changing only the JavaScript package must not leave vulnerable native binaries');
});

test('V-S01 native workerd Images still decodes and resizes a synthetic AVIF', { timeout: 30000 }, async t => {
  const avif = await sharp({ create: {
    width: 6, height: 4, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 },
  } }).avif({ lossless: true, chromaSubsampling: '4:4:4' }).toBuffer();
  assert.equal((await sharp(avif).metadata()).format, 'heif', 'the control exercises the native HEIF decoder');
  const runtime = new Miniflare({
    modules: true,
    compatibilityDate: '2026-07-30',
    images: { binding: 'IMAGES' },
    outboundService: () => { throw new Error('Synthetic Images test must not access the network'); },
    script: `export default {
      async fetch(request, env) {
        const output = await env.IMAGES.input(request.body)
          .transform({ width: 3, height: 2 })
          .output({ format: 'image/png' });
        return output.response();
      }
    }`,
  });
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('https://images.fixture.invalid/transform', {
    method: 'POST', body: avif, headers: { 'Content-Type': 'image/avif' },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(png).metadata();
  assert.deepEqual({ format: metadata.format, width: metadata.width, height: metadata.height },
    { format: 'png', width: 3, height: 2 });
  const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
  assert.deepEqual(pixels, Buffer.alloc(3 * 2 * 4, 255), 'the native conversion preserves the synthetic white pixels');
});
