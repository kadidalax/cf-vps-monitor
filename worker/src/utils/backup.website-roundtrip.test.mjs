import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBackup, encryptBackup, validateBackup } from './backup.ts';
import * as backupHelpers from './backup.ts';
import { makeWebsiteBackup, websiteConfiguration } from '../../../scripts/test-support/backup-fixture.mjs';
import { loadTypeScriptFunctions } from '../../../scripts/test-support/typescript.mjs';

test('AUD-06 the actual snapshot exporter includes configuration without stale health', async () => {
  const { buildBackupSnapshot } = await loadTypeScriptFunctions(new URL('./backup-snapshot.ts', import.meta.url), ['buildBackupSnapshot'], {
    ...backupHelpers,
    buildAdminSettings: value => value,
    db: {
      getBackupConfigurationSnapshot: async () => ({
        clients: makeWebsiteBackup().clients, settings: {}, ping_tasks: [],
        offline_notifications: [], expiry_notifications: [], load_notifications: [],
        website_monitors: websiteConfiguration.map(row => ({ ...row, status: 'down', last_checked_at: '2026-09-06T00:00:00Z' })),
      }),
    },
  });
  const snapshot = await buildBackupSnapshot({});
  assert.deepEqual(snapshot.website_monitors, websiteConfiguration);
});

test('AUD-06 encrypted configuration backup retains every website field', async () => {
  const backup = makeWebsiteBackup();
  const validated = validateBackup(backup);
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.backup.website_monitors, websiteConfiguration, 'validation must retain website configuration');
  const encrypted = await encryptBackup(backup, 'synthetic-backup-password');
  assert.equal(encrypted.ok, true);
  const decrypted = await decryptBackup(encrypted.encryptedBackup, 'synthetic-backup-password');
  assert.equal(decrypted.ok, true);
  assert.deepEqual(decrypted.backup.website_monitors, websiteConfiguration);
});

test('AUD-06 duplicate website IDs and missing restored agents are rejected', () => {
  const duplicate = makeWebsiteBackup();
  duplicate.website_monitors[1].id = duplicate.website_monitors[0].id;
  assert.equal(validateBackup(duplicate).ok, false, 'duplicate IDs must not silently overwrite a website');
  const missing = makeWebsiteBackup();
  missing.website_monitors[1].agent_probe_clients = ['missing-node'];
  assert.equal(validateBackup(missing).ok, false, 'a missing selected agent is not a valid configuration');
});

test('AUD-06 a website-only backup is a recoverable configuration module', () => {
  const result = validateBackup({ version: '2.0.0', website_monitors: websiteConfiguration });
  assert.equal(result.ok, true);
  assert.deepEqual(result.backup.website_monitors, websiteConfiguration);
});
