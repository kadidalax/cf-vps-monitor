import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8');

assert.match(source, /export const AGENT_AUTH_CACHE_MS = 120_000;/);
assert.match(source, /const AGENT_TOKEN_USAGE_CACHE_MS = 15 \* 60_000;/);
assert.match(source, /export function invalidateAgentClientAuthCache/);
assert.match(source, /markAgentTokenUsedIfDue/);
assert.match(source, /setAgentAuthCache\(agentAuthCache, cacheKey, cachedClient, AGENT_AUTH_CACHE_MS, now\);/);
assert.match(source, /setAgentAuthCache\(agentIdentityAuthCache, cacheKey, cachedClient, AGENT_AUTH_CACHE_MS, now\);/);
