const EXACT_PROTECTED_PATHS = new Set([
  '/api/admin/account/username',
  '/api/admin/account/chpasswd',
  '/api/admin/clients/batch-remove',
  '/api/admin/record/clear',
  '/api/admin/record/clear/all',
  '/api/admin/download/backup',
  '/api/admin/upload/backup',
  '/api/admin/account/mfa/setup',
  '/api/admin/account/mfa/enable',
  '/api/admin/account/mfa/recovery-codes',
  '/api/admin/account/mfa/disable',
]);

const CLIENT_SECRET_PATH = /^\/api\/admin\/clients\/[^/]+\/(?:remove|token(?:\/install|\/rotate)?)$/;

export function isMfaStepUpProtectedRequest(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  return EXACT_PROTECTED_PATHS.has(pathname) || CLIENT_SECRET_PATH.test(pathname);
}