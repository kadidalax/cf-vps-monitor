import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(source, /const RECORD_CLEANUP_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
assert.match(source, /const RECORD_CLEANUP_LAST_RUN_KEY = 'maintenance_last_cleanup_at';/);
assert.match(source, /now\.getTime\(\) - lastCleanupAt < RECORD_CLEANUP_INTERVAL_MS/);

const cleanupStart = source.indexOf('async function runRecordCleanup');
const lastRunRead = source.indexOf('Date.parse(settings[RECORD_CLEANUP_LAST_RUN_KEY]', cleanupStart);
const auditDelete = source.indexOf('db.deleteOldAuditLogs', cleanupStart);
const lastRunWrite = source.indexOf('db.setSetting(context.database, RECORD_CLEANUP_LAST_RUN_KEY', cleanupStart);
const deletedRows = source.indexOf('const deletedRows = Object.values(deleted)', cleanupStart);

assert.ok(cleanupStart > 0);
assert.ok(lastRunRead > cleanupStart);
assert.ok(auditDelete > lastRunRead);
assert.ok(lastRunWrite > auditDelete);
assert.ok(deletedRows > lastRunWrite);
