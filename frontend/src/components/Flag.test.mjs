import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./Flag.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const DEFAULT_FLAG_CODE');
const end = source.indexOf('interface FlagProps', start);
assert.ok(start >= 0 && end > start);

const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const exports = {};
new Function('exports', compiled)(exports);
const { resolveFlagCode } = exports;

assert.equal(resolveFlagCode('韩国首尔'), 'KR');
assert.equal(resolveFlagCode('甲骨文韩国首尔'), 'KR');
assert.equal(resolveFlagCode('ap-seoul-1'), 'KR');
assert.equal(resolveFlagCode('Seoul, Seoul, KR'), 'KR');
assert.equal(resolveFlagCode('North Korea, KP'), 'KP');
assert.equal(resolveFlagCode('KP'), 'KP');
assert.equal(resolveFlagCode('South Korea, KR'), 'KR');
assert.equal(resolveFlagCode('ap-tokyo-1'), 'JP');
assert.equal(resolveFlagCode('eu-frankfurt-1'), 'DE');
assert.equal(resolveFlagCode('未知地区'), 'UN');
