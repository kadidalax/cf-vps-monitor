import assert from 'node:assert/strict';

const { maskSecretPreview, isMaskedSecretPreview } = await import('./secret-preview.ts');

// ── 典型 Telegram bot token：两头明文、中间固定 8 个星号 ──
{
  const token = '1234567890:AAEabcdefghijklmnopqrstuvwxyz';
  const masked = maskSecretPreview(token);
  assert.equal(masked, '1234********wxyz');
  // 关键安全属性：预览串里不得出现原值的中段
  assert.equal(masked.includes('AAEabcdefghij'), false);
  assert.ok(masked.length < token.length);
}

// ── 未配置返回空串，调用方据此显示「未配置」 ──
assert.equal(maskSecretPreview(''), '');
assert.equal(maskSecretPreview('   '), '');
assert.equal(maskSecretPreview(null), '');
assert.equal(maskSecretPreview(undefined), '');
assert.equal(maskSecretPreview(12345), '');

// ── 过短的值全部打码，不露出任何明文 ──
for (const short of ['abc', 'secret', 'abcdefghijk']) {
  const masked = maskSecretPreview(short);
  assert.equal(masked, '********', `短值应全打码: ${short}`);
  for (const ch of short) {
    // 逐字符确认没有把原文泄进预览
    assert.equal(masked.includes(ch), false, `短值不应泄露字符 ${ch}`);
  }
}

// 恰好到达阈值（12 位）才开始露出两头
assert.equal(maskSecretPreview('abcdefghijkl'), 'abcd********ijkl');
assert.equal(maskSecretPreview('abcdefghijk'), '********');

// ── 星号数量固定，不随原值长度变化（避免反推长度） ──
{
  const a = maskSecretPreview('a'.repeat(20));
  const b = maskSecretPreview('a'.repeat(200));
  assert.equal(a.length, b.length, '不同长度的原值应产生等长预览');
  assert.equal(a.length, 16);
}

// ── Telegram Chat ID：与 bot token 同等对待 ──
{
  // 个人 chat id 通常 10 位左右，不足 12 位阈值 → 整串打码，不露出任何数字
  const personal = '1029083084';
  assert.equal(maskSecretPreview(personal), '********');
  for (const ch of personal) {
    assert.equal(maskSecretPreview(personal).includes(ch), false, `个人 chat id 不应泄露 ${ch}`);
  }
  // 群组 chat id 带负号且更长，露出两头便于管理员辨认配的是哪个群
  assert.equal(maskSecretPreview('-1001234567890'), '-100********7890');
}

// ── isMaskedSecretPreview：识别预览串，防止被当成真实值写库 ──
assert.equal(isMaskedSecretPreview(maskSecretPreview('1234567890:AAEabcdefg')), true);
assert.equal(isMaskedSecretPreview('********'), true);
assert.equal(isMaskedSecretPreview('a-real-token-value'), false);
assert.equal(isMaskedSecretPreview(''), false);
assert.equal(isMaskedSecretPreview(null), false);
assert.equal(isMaskedSecretPreview(undefined), false);
assert.equal(isMaskedSecretPreview(123), false);

console.log('secret-preview tests passed');
