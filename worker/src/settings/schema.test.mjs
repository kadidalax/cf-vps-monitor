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
assert.deepEqual(normalizeSettingValue('update_mode', 'fork'), { ok: false, error: '未知设置: update_mode' });

const publicSettings = buildPublicSettings({
  site_logo_url: '/api/site-logo?v=1',
  site_logo_data: 'private-image-data',
  site_logo_type: 'image/png',
});

assert.equal(publicSettings.site_logo_url, '/api/site-logo?v=1');
assert.equal('site_logo_data' in publicSettings, false);
assert.equal('site_logo_type' in publicSettings, false);
