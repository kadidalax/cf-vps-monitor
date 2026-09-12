import assert from 'node:assert/strict';

const {
  NOTIFICATION_DISPATCH_SETTING_KEYS,
  dispatchNotification,
  pickNotificationSettingOverrides,
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

// ── pickNotificationSettingOverrides：通知测试以表单当前值为准 ──
{
  // Telegram：未保存的 bot token / chat id 也能参与测试
  const tg = pickNotificationSettingOverrides({
    telegram_bot_token: '123:ABC',
    telegram_chat_id: '-1001',
  });
  assert.deepEqual(tg, { telegram_bot_token: '123:ABC', telegram_chat_id: '-1001' });

  // Webhook 与邮件同样支持
  const webhook = pickNotificationSettingOverrides({ webhook_url: 'https://e.x/h', webhook_secret: 's' });
  assert.deepEqual(webhook, { webhook_url: 'https://e.x/h', webhook_secret: 's' });
  const mail = pickNotificationSettingOverrides({ email_smtp_host: 'smtp.x', email_smtp_password: 'p' });
  assert.deepEqual(mail, { email_smtp_host: 'smtp.x', email_smtp_password: 'p' });

  // 数字/布尔转成字符串，交给 buildAdminSettings 归一化
  assert.deepEqual(pickNotificationSettingOverrides({ email_smtp_port: 465 }), { email_smtp_port: '465' });

  // 不在白名单里的键一律忽略，避免借测试接口写到无关设置
  assert.deepEqual(pickNotificationSettingOverrides({ admin_password: 'x', site_title: 'y' }), {});

  // 未提供的字段不出现在覆盖项里 → 调用方会回落到已保存值
  assert.equal('telegram_chat_id' in pickNotificationSettingOverrides({ telegram_bot_token: 't' }), false);

  // 空串按「未提供」处理：密钥类字段在表单里是脱敏的，未改动时前端拿到空串，
  // 若当成显式覆盖会把本来能用的配置测成未配置。
  assert.deepEqual(pickNotificationSettingOverrides({ webhook_url: '' }), {});
  assert.deepEqual(pickNotificationSettingOverrides({ email_smtp_password: '   ' }), {});
  assert.deepEqual(
    pickNotificationSettingOverrides({ telegram_bot_token: '', telegram_chat_id: '-100' }),
    { telegram_chat_id: '-100' },
  );

  // 非对象输入安全返回空
  for (const bad of [null, undefined, 'str', 42, [], true]) {
    assert.deepEqual(pickNotificationSettingOverrides(bad), {});
  }
}

console.log('notification-dispatch tests passed');

// 掩码预览串不得被当成真实值参与测试：它只是给人看的，
// 拿去连 Telegram/SMTP 必然失败，应回落到已保存值。
{
  assert.deepEqual(pickNotificationSettingOverrides({ telegram_bot_token: '1234********wxyz' }), {});
  assert.deepEqual(pickNotificationSettingOverrides({ email_smtp_password: '********' }), {});
  assert.deepEqual(
    pickNotificationSettingOverrides({ telegram_bot_token: '1234********wxyz', telegram_chat_id: '-100' }),
    { telegram_chat_id: '-100' },
  );
  // 真实值里恰好含单个星号不应被误判
  assert.deepEqual(pickNotificationSettingOverrides({ webhook_secret: 'a*b' }), { webhook_secret: 'a*b' });
}

console.log('notification-dispatch mask tests passed');
