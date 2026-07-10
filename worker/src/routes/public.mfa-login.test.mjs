import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./public.ts', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
const passwordRoute = source.slice(source.indexOf("publicRoutes.post('/login'"), source.indexOf("publicRoutes.post('/login/mfa'"));
const mfaRoute = source.slice(source.indexOf("publicRoutes.post('/login/mfa'"), source.indexOf('// 退出登录'));

assert.match(passwordRoute, /user\.totp_enabled_at\s*&&\s*user\.totp_secret_enc/);
assert.match(passwordRoute, /code:\s*'MFA_REQUIRED'/);
assert.match(passwordRoute, /generateMfaToken\(/);
const challengeBranch = passwordRoute.match(/if \(user\.totp_enabled_at[^]*?return c\.json\(\{[^]*?MFA_REQUIRED[^]*?\}\);[^]*?\}/)?.[0] || '';
assert.ok(challengeBranch, 'password login must have an MFA challenge branch');
assert.doesNotMatch(challengeBranch, /setAdminSessionCookie\(/);

assert.match(mfaRoute, /verifyMfaToken\([^;]+['"]mfa-login['"]/s);
assert.match(mfaRoute, /db\.getUserByUuid\(/);
assert.match(mfaRoute, /payload\.sessionVersion/);
assert.match(mfaRoute, /decryptTotpSecret\(/);
assert.match(mfaRoute, /verifyTotpCode\(/);
assert.match(mfaRoute, /db\.consumeTotpStep\(/);
assert.match(mfaRoute, /hashRecoveryCode\(/);
assert.match(mfaRoute, /db\.consumeRecoveryCode\(/);
assert.match(source, /async function completeAdminLogin[^]*?clearLoginFailures\(/);
assert.match(mfaRoute, /completeAdminLogin\(/);
assert.match(source, /async function completeAdminLogin[^]*?setAdminSessionCookie\(/);
assert.match(indexSource, /pathname === '\/api\/login\/mfa'/);
