import assert from 'node:assert/strict';
import test from 'node:test';
import { isMfaStepUpProtectedRequest } from './mfa-policy.ts';

const protectedRequests = [
  ['POST', '/api/admin/account/username'],
  ['POST', '/api/admin/account/chpasswd'],
  ['POST', '/api/admin/clients/node-1/remove'],
  ['POST', '/api/admin/clients/batch-remove'],
  ['POST', '/api/admin/clients/node-1/token'],
  ['POST', '/api/admin/clients/node-1/token/install'],
  ['POST', '/api/admin/clients/node-1/token/rotate'],
  ['POST', '/api/admin/record/clear'],
  ['POST', '/api/admin/record/clear/all'],
  ['POST', '/api/admin/download/backup'],
  ['POST', '/api/admin/upload/backup'],
  ['POST', '/api/admin/account/mfa/setup'],
  ['POST', '/api/admin/account/mfa/enable'],
  ['POST', '/api/admin/account/mfa/recovery-codes'],
  ['POST', '/api/admin/account/mfa/disable'],
];

for (const [method, path] of protectedRequests) {
  test(`protects ${method} ${path}`, () => {
    assert.equal(isMfaStepUpProtectedRequest(method, path), true);
  });
}

test('does not recursively protect the step-up endpoint or ordinary edits', () => {
  assert.equal(isMfaStepUpProtectedRequest('POST', '/api/admin/account/mfa/step-up'), false);
  assert.equal(isMfaStepUpProtectedRequest('GET', '/api/admin/account/mfa'), false);
  assert.equal(isMfaStepUpProtectedRequest('POST', '/api/admin/clients/reorder'), false);
  assert.equal(isMfaStepUpProtectedRequest('GET', '/api/admin/clients/node-1/token'), false);
});