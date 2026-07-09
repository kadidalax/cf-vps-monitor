import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./admin.ts', import.meta.url), 'utf8');

assert.match(source, /'webhook_url'/);
assert.match(source, /'webhook_format'/);
assert.match(source, /'webhook_secret'/);
assert.match(source, /'webhook_method'/);
assert.match(source, /'webhook_content_type'/);
assert.match(source, /'webhook_headers_json'/);
assert.match(source, /'webhook_body_template'/);
assert.match(source, /'webhook_username'/);
assert.match(source, /'webhook_password'/);
assert.match(source, /'webhook_retry_count'/);
assert.match(source, /scoped\.webhook_url_set = settings\.webhook_url \? 'true' : 'false';/);
assert.match(source, /scoped\.webhook_secret_set = settings\.webhook_secret \? 'true' : 'false';/);
assert.match(source, /scoped\.webhook_headers_set = settings\.webhook_headers_json \? 'true' : 'false';/);
assert.match(source, /scoped\.webhook_password_set = settings\.webhook_password \? 'true' : 'false';/);
assert.match(source, /delete scoped\['webhook_url'\];/);
assert.match(source, /delete scoped\['webhook_secret'\];/);
assert.match(source, /delete scoped\['webhook_headers_json'\];/);
assert.match(source, /delete scoped\['webhook_password'\];/);
assert.match(source, /delete settingsBody\.webhook_url_clear;/);
assert.match(source, /delete settingsBody\.webhook_secret_clear;/);
assert.match(source, /delete settingsBody\.webhook_headers_set;/);
assert.match(source, /delete settingsBody\.webhook_password_set;/);
assert.match(source, /WEBHOOK_MESSAGE_MAX_CHARS/);
assert.match(source, /message\.length > maxMessageChars/);
