import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Account.tsx', import.meta.url), 'utf8');
assert.match(source, /value="security"/);
assert.match(source, /QRCode\.toDataURL\(/);
assert.match(source, /\/admin\/account\/mfa\/setup/);
assert.match(source, /\/admin\/account\/mfa\/enable/);
assert.match(source, /\/admin\/account\/mfa\/recovery-codes/);
assert.match(source, /\/admin\/account\/mfa\/disable/);
assert.match(source, /downloadRecoveryCodes\(/);
assert.doesNotMatch(source, /window\.confirm/);
assert.match(source, /open=\{disableDialogOpen\}/);
assert.match(source, /确认关闭双重身份验证/);
assert.match(source, /await requestMfaStepUp\(\)/);
assert.match(source, /恢复码只显示这一次/);
