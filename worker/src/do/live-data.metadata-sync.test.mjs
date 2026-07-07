import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./live-data.ts', import.meta.url), 'utf8');

assert.match(source, /private networkMetadataSignatures = new Map<string, \{ signature: string; syncedAt: number \}>\(\);/);
assert.match(source, /private basicInfoSignatures = new Map<string, string>\(\);/);
assert.match(source, /const WEBSITE_PROBE_TASK_CACHE_MS = 120_000;/);
assert.match(source, /private websiteProbeTasksCache: Map<string, \{ value: db\.WebsiteMonitor\[\]; expiresAt: number \}> = new Map\(\);/);
assert.match(source, /this\.invalidateWebsiteProbeTasksCache\(\);/);
assert.match(source, /if \(previous\?\.signature === signature\) return;/);
assert.match(source, /if \(this\.basicInfoSignatures\.get\(clientId\) === signature\) return;/);
assert.doesNotMatch(source, /LIVE_NETWORK_METADATA_SYNC_MS/);
