import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installWranglerWrapper } from './install-wrangler-wrapper.mjs';

const root = mkdtempSync(join(tmpdir(), 'wrangler-wrapper-'));
try {
  const realWrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const binWrangler = join(root, 'node_modules', '.bin', 'wrangler');
  mkdirSync(join(root, 'node_modules', 'wrangler', 'bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(realWrangler, 'REAL_WRANGLER');
  linkSync(realWrangler, binWrangler);

  installWranglerWrapper(root);

  assert.equal(readFileSync(realWrangler, 'utf8'), 'REAL_WRANGLER');
  assert.match(readFileSync(binWrangler, 'utf8'), /wrangler-wrapper\.mjs/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
