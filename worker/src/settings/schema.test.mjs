import assert from 'node:assert/strict';

const {
  buildPublicSettings,
  normalizeSettingValue,
} = await import('./schema.ts');

assert.equal(normalizeSettingValue('site_logo_url', '/api/site-logo?v=1').ok, true);
assert.equal(normalizeSettingValue('site_logo_url', 'https://example.com/logo.png').ok, false);
assert.equal(normalizeSettingValue('site_logo_type', 'image/png').ok, true);
assert.equal(normalizeSettingValue('site_logo_data', 'a'.repeat(1500001)).ok, false);

const publicSettings = buildPublicSettings({
  site_logo_url: '/api/site-logo?v=1',
  site_logo_data: 'private-image-data',
  site_logo_type: 'image/png',
});

assert.equal(publicSettings.site_logo_url, '/api/site-logo?v=1');
assert.equal('site_logo_data' in publicSettings, false);
assert.equal('site_logo_type' in publicSettings, false);
