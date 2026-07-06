import assert from 'node:assert/strict';

const { shouldCheckAdminSessionOnLoad } = await import('./auth-state.ts');

assert.equal(shouldCheckAdminSessionOnLoad('/'), true);
assert.equal(shouldCheckAdminSessionOnLoad('/instance/server-1'), true);
assert.equal(shouldCheckAdminSessionOnLoad('/admin'), true);
assert.equal(shouldCheckAdminSessionOnLoad('/login'), true);

