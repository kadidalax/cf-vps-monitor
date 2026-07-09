import assert from 'node:assert/strict';

const {
  NOTIFICATION_DISPATCH_SETTING_KEYS,
  dispatchNotification,
} = await import('./notification-dispatch.ts');

assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_url'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_format'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_secret'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_method'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_content_type'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_headers_json'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_body_template'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_username'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_password'));
assert.ok(NOTIFICATION_DISPATCH_SETTING_KEYS.includes('webhook_retry_count'));

const notification = { subject: '测试标题', body: '测试正文' };

{
  const events = [];
  const sent = await dispatchNotification(undefined, { notification_method: 'none' }, notification, {
    deps: {
      recordHealth: async (...args) => { events.push(args); },
    },
  });
  assert.equal(sent, false);
  assert.equal(events[0][1], 'notification');
  assert.equal(events[0][2], 'disabled');
}

{
  const calls = [];
  const events = [];
  const sent = await dispatchNotification(undefined, {
    notification_method: 'webhook',
    webhook_url: 'https://hooks.example.com/hook',
    webhook_format: 'dingtalk',
    webhook_secret: 'secret',
    webhook_method: 'GET',
    webhook_content_type: 'text/plain',
    webhook_headers_json: '{"X-Test":"ok"}',
    webhook_body_template: 'title={{title}}',
    webhook_username: 'user',
    webhook_password: 'pass',
    webhook_retry_count: '3',
  }, notification, {
    deps: {
      sendWebhook: async (config, message) => {
        calls.push({ config, message });
        return { ok: true, status: 204, host: 'hooks.example.com' };
      },
      recordHealth: async (...args) => { events.push(args); },
    },
  });
  assert.equal(sent, true);
  assert.deepEqual(calls[0], {
    config: {
      url: 'https://hooks.example.com/hook',
      format: 'dingtalk',
      secret: 'secret',
      method: 'GET',
      contentType: 'text/plain',
      headersJson: '{"X-Test":"ok"}',
      bodyTemplate: 'title={{title}}',
      username: 'user',
      password: 'pass',
      retryCount: 3,
    },
    message: notification,
  });
  assert.equal(events[0][1], 'webhook');
  assert.equal(events[0][2], 'ok');
}

{
  const events = [];
  const sent = await dispatchNotification(undefined, {
    notification_method: 'webhook',
    webhook_format: 'generic',
  }, notification, {
    deps: {
      recordHealth: async (...args) => { events.push(args); },
    },
  });
  assert.equal(sent, false);
  assert.equal(events[0][1], 'webhook');
  assert.equal(events[0][2], 'disabled');
}
