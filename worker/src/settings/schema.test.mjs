import assert from 'node:assert/strict';

const {
  buildAdminSettings,
  buildPublicSettings,
  normalizeSettingValue,
  sanitizeSettingsForStorage,
} = await import('./schema.ts');

assert.equal(normalizeSettingValue('site_logo_url', '/api/site-logo?v=1').ok, true);
assert.equal(normalizeSettingValue('site_logo_url', 'https://example.com/logo.png').ok, false);
assert.equal(normalizeSettingValue('site_logo_type', 'image/png').ok, true);
assert.equal(normalizeSettingValue('site_logo_data', 'a'.repeat(1500001)).ok, false);
assert.deepEqual(
  normalizeSettingValue('update_repository_url', 'github.com/example/cf-vps-monitor.git'),
  { ok: true, value: 'https://github.com/example/cf-vps-monitor' },
);
assert.equal(normalizeSettingValue('update_repository_url', 'https://github.com/example/cf-vps-monitor/tree/main').ok, false);
assert.deepEqual(normalizeSettingValue('notification_method', 'webhook'), { ok: true, value: 'webhook' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'discord'), { ok: true, value: 'discord' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'custom'), { ok: true, value: 'custom' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'dingtalk'), { ok: true, value: 'dingtalk' });
assert.deepEqual(normalizeSettingValue('webhook_format', 'wecom'), { ok: true, value: 'wecom' });
assert.equal(normalizeSettingValue('webhook_url', 'https://hooks.example.com/path?token=secret').ok, true);
assert.equal(normalizeSettingValue('webhook_url', 'http://hooks.example.com/path').ok, false);
assert.equal(normalizeSettingValue('webhook_url', 'https://127.0.0.1/path').ok, false);
assert.deepEqual(normalizeSettingValue('webhook_method', 'GET'), { ok: true, value: 'GET' });
assert.deepEqual(normalizeSettingValue('webhook_method', 'POST'), { ok: true, value: 'POST' });
assert.equal(normalizeSettingValue('webhook_method', 'PUT').ok, false);
assert.deepEqual(normalizeSettingValue('webhook_retry_count', '3'), { ok: true, value: '3' });
assert.equal(normalizeSettingValue('webhook_retry_count', '0').ok, false);
assert.equal(normalizeSettingValue('webhook_retry_count', '4').ok, false);
assert.deepEqual(normalizeSettingValue('webhook_headers_json', '{"X-Test":"ok"}'), { ok: true, value: '{"X-Test":"ok"}' });
assert.equal(normalizeSettingValue('webhook_headers_json', '[]').ok, false);
assert.equal(normalizeSettingValue('webhook_headers_json', '{"X-Test":1}').ok, false);
assert.equal(normalizeSettingValue('webhook_content_type', 'application/json; charset=utf-8').ok, true);
assert.equal(normalizeSettingValue('webhook_content_type', 'application/json\r\nX-Bad: 1').ok, false);
assert.deepEqual(normalizeSettingValue('update_mode', 'fork'), { ok: false, error: '未知设置: update_mode' });

const publicSettings = buildPublicSettings({
  site_logo_url: '/api/site-logo?v=1',
  site_logo_data: 'private-image-data',
  site_logo_type: 'image/png',
});

assert.equal(publicSettings.site_logo_url, '/api/site-logo?v=1');
assert.equal('site_logo_data' in publicSettings, false);
assert.equal('site_logo_type' in publicSettings, false);

// webhook 自指：写入路径拦，读取路径不拦。
const SELF = 'monitor.example.com';
const SELF_URL = `https://${SELF}/api/hook`;

// 不传 selfHost 时行为与改动前一致——已有调用方（读取路径）不知道自己的域名。
assert.equal(normalizeSettingValue('webhook_url', SELF_URL).ok, true);
// 传了就拦，且提示要说人话，不能只回通用的「类型或取值无效」。
const selfResult = normalizeSettingValue('webhook_url', SELF_URL, SELF);
assert.equal(selfResult.ok, false);
assert.match(selfResult.error, /不能填本站地址/);
// 外部地址照常通过，并被归一化
assert.deepEqual(
  normalizeSettingValue('webhook_url', 'https://hooks.example.com/hook', SELF),
  { ok: true, value: 'https://hooks.example.com/hook' },
);
// 清空仍然允许：用户得有办法把坏值删掉
assert.deepEqual(normalizeSettingValue('webhook_url', '', SELF), { ok: true, value: '' });
// 非法地址仍走通用提示，不该被 self_host 的话术盖掉
assert.match(normalizeSettingValue('webhook_url', 'http://example.com/h', SELF).error, /类型或取值无效/);

// 透传到写入入口
const rejected = sanitizeSettingsForStorage({ webhook_url: SELF_URL }, { selfHost: SELF });
assert.equal(rejected.ok, false);
assert.match(rejected.errors.join(' | '), /不能填本站地址/);
assert.deepEqual(
  sanitizeSettingsForStorage({ webhook_url: SELF_URL }).errors,
  [],
  '不传 selfHost 时不该拦',
);

// 读取路径绝不能拦：否则存量坏值每次读取都判无效、回落成默认值，等于静默清空用户配置。
assert.equal(buildAdminSettings({ webhook_url: SELF_URL }).webhook_url, SELF_URL);
