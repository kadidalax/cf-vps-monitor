import assert from 'node:assert/strict';

const { formatCpuCardLabel, formatCpuSpec } = await import('./cpuFormat.ts');

assert.equal(formatCpuCardLabel('Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz', 2), 'Xeon E5-2680 v4 x2');
assert.equal(formatCpuCardLabel('AMD EPYC 7B13 64-Core Processor', 4), 'EPYC 7B13 x4');
assert.equal(formatCpuCardLabel('AMD Ryzen 9 7950X 16-Core Processor', 32), 'Ryzen 9 7950X x32');
assert.equal(formatCpuCardLabel('Intel(R) Core(TM) i9-13900K CPU @ 3.00GHz', 24), 'Core i9-13900K x24');
assert.equal(formatCpuCardLabel('Intel(R) N100', 4), 'N100 x4');
assert.equal(formatCpuCardLabel('ARM Neoverse-N1', 2), 'Neoverse-N1 x2');
assert.equal(formatCpuCardLabel('Cortex-A76', 4), 'Cortex-A76 x4');
assert.equal(formatCpuCardLabel('Apple M2', 8), 'Apple M2 x8');
assert.equal(formatCpuCardLabel('Common KVM processor', 1), 'KVM x1');
assert.equal(formatCpuCardLabel('QEMU Virtual CPU version 2.5+', 1), 'QEMU x1');
assert.equal(formatCpuCardLabel('Very Very Long Unknown Processor Name With Many Words', 16), 'Very Very Long x16');
assert.equal(formatCpuCardLabel('', 4), 'x4');
assert.equal(formatCpuCardLabel('Intel(R) N100', 0), 'N100');

assert.equal(formatCpuSpec('Intel(R) N100', 4), 'Intel(R) N100 (x4)');
assert.equal(formatCpuSpec('', 4), 'x4');
assert.equal(formatCpuSpec('', 0), '-');
