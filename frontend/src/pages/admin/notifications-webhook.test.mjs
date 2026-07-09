import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Notifications.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

assert.match(source, /<Select\.Item value="webhook">Webhook<\/Select\.Item>/);
assert.match(source, /webhookOpen/);
assert.match(source, /webhook_url/);
assert.match(source, /webhook_format/);
assert.match(source, /webhook_secret/);
assert.match(source, /<Select\.Item value="custom">/);
assert.match(source, /<Select\.Item value="dingtalk">/);
assert.match(source, /<Select\.Item value="wecom">/);
assert.match(source, /webhook_method/);
assert.match(source, /webhook_content_type/);
assert.match(source, /webhook_retry_count/);
assert.match(source, /webhook_headers_json/);
assert.match(source, /webhook_body_template/);
assert.match(source, /webhook_username/);
assert.match(source, /webhook_password/);
assert.match(source, /\{\{title\}\}/);
assert.match(source, /\{\{message\}\}/);
assert.match(source, /\{\{source\}\}/);
assert.match(css, /\.notification-webhook-custom-grid[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
assert.match(css, /\.notification-webhook-custom-grid \.notification-webhook-field-description[\s\S]*min-height:\s*32px/);
assert.doesNotMatch(source, /清空 URL/);
assert.doesNotMatch(source, /清空 Secret/);
assert.match(source, /channel: 'webhook'/);
