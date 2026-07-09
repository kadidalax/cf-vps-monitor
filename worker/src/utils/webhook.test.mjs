import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const {
  buildWebhookRequest,
  sendWebhookMessage,
  validateWebhookUrl,
} = await import('./webhook.ts');

const source = readFileSync(new URL('./webhook.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /response\.text\(\)/);

for (const url of [
  'http://example.com/hook',
  'https://localhost/hook',
  'https://127.0.0.1/hook',
  'https://10.0.0.1/hook',
  'https://169.254.169.254/latest/meta-data',
  'https://user:pass@example.com/hook',
]) {
  assert.equal(validateWebhookUrl(url).ok, false, url);
}

assert.deepEqual(validateWebhookUrl('https://hooks.example.com/path?token=secret'), {
  ok: true,
  url: 'https://hooks.example.com/path?token=secret',
  host: 'hooks.example.com',
});

const notification = { subject: '告警标题', body: '事件: 测试\n消息: 正文' };
assert.deepEqual(
  JSON.parse((await buildWebhookRequest({ url: 'https://hooks.example.com/hook', format: 'slack' }, notification)).body),
  { text: notification.body },
);
assert.deepEqual(
  JSON.parse((await buildWebhookRequest({ url: 'https://hooks.example.com/hook', format: 'discord' }, notification)).body),
  { content: notification.body, allowed_mentions: { parse: [] } },
);
assert.deepEqual(
  JSON.parse((await buildWebhookRequest({ url: 'https://hooks.example.com/hook', format: 'feishu' }, notification)).body),
  { msg_type: 'text', content: { text: notification.body } },
);
assert.deepEqual(
  JSON.parse((await buildWebhookRequest({ url: 'https://oapi.dingtalk.com/robot/send?access_token=token', format: 'dingtalk' }, notification)).body),
  { msgtype: 'text', text: { content: notification.body } },
);
assert.deepEqual(
  JSON.parse((await buildWebhookRequest({ url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=key', format: 'wecom' }, notification)).body),
  { msgtype: 'text', text: { content: notification.body } },
);

const generic = await buildWebhookRequest({
  url: 'https://hooks.example.com/hook',
  format: 'generic',
  secret: 'secret',
  nowMs: 1700000000000,
}, notification);
assert.deepEqual(JSON.parse(generic.body), {
  source: 'cf-vps-monitor',
  subject: notification.subject,
  message: notification.body,
  event_time: '2023-11-14T22:13:20.000Z',
});
assert.equal(generic.headers['X-CFVM-Timestamp'], '1700000000');
assert.match(generic.headers['X-CFVM-Signature'], /^sha256=[0-9a-f]{64}$/);

const feishuSigned = await buildWebhookRequest({
  url: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
  format: 'feishu',
  secret: 'secret',
  nowMs: 1700000000000,
}, notification);
assert.deepEqual(JSON.parse(feishuSigned.body), {
  msg_type: 'text',
  content: { text: notification.body },
  timestamp: '1700000000',
  sign: 'fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=',
});

const dingtalkSigned = await buildWebhookRequest({
  url: 'https://oapi.dingtalk.com/robot/send?access_token=token',
  format: 'dingtalk',
  secret: 'secret',
  nowMs: 1700000000000,
}, notification);
const dingtalkUrl = new URL(dingtalkSigned.url);
const dingtalkExpectedSign = createHmac('sha256', 'secret')
  .update('1700000000000\nsecret')
  .digest('base64');
assert.equal(dingtalkUrl.searchParams.get('timestamp'), '1700000000000');
assert.equal(dingtalkUrl.searchParams.get('sign'), dingtalkExpectedSign);
assert.equal(dingtalkSigned.host, 'oapi.dingtalk.com');

const calls = [];
const result = await sendWebhookMessage(
  { url: 'https://hooks.example.com/hook', format: 'generic' },
  notification,
  {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response('x'.repeat(2000), { status: 403 });
    },
  },
);
assert.equal(calls[0].init.redirect, 'manual');
assert.deepEqual(result, {
  ok: false,
  status: 403,
  host: 'hooks.example.com',
  error: `HTTP 403: ${'x'.repeat(1024)}`,
});

const structuredNotification = {
  subject: 'alert "title"',
  body: 'line one\nline two "quoted" \\ slash',
  event: 'offline_alert',
  clients: 'hong-kong-node',
  time: '2026-07-09 12:00:00',
  emoji: '!',
};

const customPost = await buildWebhookRequest({
  url: 'https://hooks.example.com/custom',
  format: 'custom',
  method: 'POST',
  contentType: 'application/json; charset=utf-8',
  headersJson: '{"X-Token":"abc"}',
  bodyTemplate: '{"title":"{{title}}","message":"{{message}}","event":"{{event}}","client":"{{client}}","time":"{{time}}","emoji":"{{emoji}}","source":"{{source}}"}',
}, structuredNotification);
assert.equal(customPost.method, 'POST');
assert.equal(customPost.headers['Content-Type'], 'application/json; charset=utf-8');
assert.equal(customPost.headers['X-Token'], 'abc');
assert.deepEqual(JSON.parse(customPost.body), {
  title: structuredNotification.subject,
  message: structuredNotification.body,
  event: structuredNotification.event,
  client: structuredNotification.clients,
  time: structuredNotification.time,
  emoji: structuredNotification.emoji,
  source: 'cf-vps-monitor',
});

const customGet = await buildWebhookRequest({
  url: 'https://hooks.example.com/send?title={{title}}&message={{message}}',
  format: 'custom',
  method: 'GET',
}, structuredNotification);
assert.equal(customGet.method, 'GET');
assert.equal(customGet.body, undefined);
assert.match(customGet.url, /title=alert/);
assert.match(customGet.url, /message=line/);

await assert.rejects(
  () => buildWebhookRequest({
    url: 'https://127.0.0.1/send?message={{message}}',
    format: 'custom',
    method: 'GET',
  }, notification),
  /unsafe_host|invalid_/,
);

await assert.rejects(
  () => buildWebhookRequest({
    url: 'https://hooks.example.com/custom',
    format: 'custom',
    headersJson: '[]',
  }, notification),
  /headers_json_must_be_object/,
);

await assert.rejects(
  () => buildWebhookRequest({
    url: 'https://hooks.example.com/custom',
    format: 'custom',
    headersJson: '{"Host":"example.com"}',
  }, notification),
  /forbidden_header/,
);

const basicAuth = await buildWebhookRequest({
  url: 'https://hooks.example.com/custom',
  format: 'custom',
  username: 'user',
  password: 'pass',
}, notification);
assert.match(basicAuth.headers.Authorization, /^Basic /);

await assert.rejects(
  () => buildWebhookRequest({
    url: 'https://hooks.example.com/custom',
    format: 'custom',
    headersJson: '{"Authorization":"Bearer token"}',
    username: 'user',
    password: 'pass',
  }, notification),
  /authorization_conflict/,
);

const retryCalls = [];
const retryResult = await sendWebhookMessage(
  { url: 'https://hooks.example.com/hook', format: 'custom', retryCount: 3 },
  notification,
  {
    fetch: async (url, init) => {
      retryCalls.push({ url, init });
      return new Response(retryCalls.length < 3 ? 'fail' : 'ok', { status: retryCalls.length < 3 ? 500 : 200 });
    },
  },
);
assert.equal(retryCalls.length, 3);
assert.equal(retryResult.ok, true);
