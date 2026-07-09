import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./observability.ts', import.meta.url), 'utf8');

assert.match(source, /'telegram'/);
assert.match(source, /'email'/);
assert.match(source, /'webhook'/);
