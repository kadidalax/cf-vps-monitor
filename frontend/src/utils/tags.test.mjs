import assert from 'node:assert/strict';

const { getVisibleMonitorTags } = await import('./tags.ts');

assert.deepEqual(
  getVisibleMonitorTags('香港<cyan>;解锁;ipv4;CN2<blue>;ipv6;高速;线路', 4),
  [
    { text: '香港', color: 'cyan' },
    { text: '解锁', color: null },
    { text: 'CN2', color: 'blue' },
    { text: '高速', color: null },
  ],
);

assert.equal(getVisibleMonitorTags(['香港', '解锁', '线路'], 2).length, 2);
assert.deepEqual(getVisibleMonitorTags('ipv4;v6;ip6', 4), []);
