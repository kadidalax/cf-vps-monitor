import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./NodeCard.tsx', import.meta.url), 'utf8');

assert.match(source, /expired_at=\{client\.expired_at\}/);
assert.match(source, /showExpiry/);
assert.doesNotMatch(source, /osConfig\.name\}\s*\/\s*\{client\.arch/);
