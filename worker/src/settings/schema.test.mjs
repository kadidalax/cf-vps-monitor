import assert from 'node:assert/strict';

const {
  buildPublicSettings,
  normalizeSettingValue,
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
