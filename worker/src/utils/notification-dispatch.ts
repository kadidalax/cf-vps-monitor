import type * as db from '../db/queries';
import { normalizeRecipients, sendSmtpEmail, type SmtpConfig, type SmtpResult } from './email.ts';
import type { NotificationMessage } from './notification-templates.ts';
import { formatTelegramHtmlText, sendTelegramMessage } from './telegram.ts';
import { sendWebhookMessage, type WebhookFormat, type WebhookSendResult } from './webhook.ts';
import { isMaskedSecretPreview } from './secret-preview.ts';
import type { StoredHealthComponent } from './observability.ts';
import type { NotificationDeliveryClaim } from '../db/types.ts';
import { consumeScheduledSubrequests, currentScheduledBudget, ScheduledBudgetExceeded } from './scheduled-budget.ts';

export async function deliverNotification(operations: {
  claim(): Promise<NotificationDeliveryClaim>;
  complete(token: string, success: boolean): Promise<boolean>;
  send(): Promise<boolean>;
  onDelivered?(token: string): Promise<boolean>;
}): Promise<boolean> {
  const claim = await operations.claim();
  if (claim.delivered) {
    if (!operations.onDelivered) return true;
    return claim.token ? operations.onDelivered(claim.token) : false;
  }
  if (!claim.claimed || !claim.token) return false;
  let sent = false;
  try {
    sent = await operations.send();
  } catch (error) {
    if (error instanceof ScheduledBudgetExceeded) throw error;
    console.error('[notification] delivery attempt failed:', errorDetail(error));
  }
  const recorded = await operations.complete(claim.token, sent);
  if (!sent || !recorded) return false;
  return operations.onDelivered ? operations.onDelivered(claim.token) : true;
}

export const NOTIFICATION_DISPATCH_SETTING_KEYS = [
  'notification_method',
  'telegram_bot_token',
  'telegram_chat_id',
  'email_smtp_host',
  'email_smtp_port',
  'email_smtp_security',
  'email_smtp_username',
  'email_smtp_password',
  'email_smtp_from_address',
  'email_smtp_from_name',
  'email_smtp_recipients',
  'email_smtp_auth_method',
  'webhook_url',
  'webhook_format',
  'webhook_secret',
  'webhook_method',
  'webhook_content_type',
  'webhook_headers_json',
  'webhook_body_template',
  'webhook_username',
  'webhook_password',
  'webhook_retry_count',
] as const;

/**
 * 从请求体里挑出可用于「以表单当前值测试」的通知配置覆盖项。
 *
 * 用途：通知测试不应要求先保存。调用方把本函数的结果覆盖到数据库读出的设置之上，
 * 再交给 `buildAdminSettings` 统一归一化，这样表单值与已保存值走完全相同的校验路径，
 * 也不会引入第二套字段命名。
 *
 * 只接受 `NOTIFICATION_DISPATCH_SETTING_KEYS` 里的键，其余一律忽略，
 * 避免请求体借这条路径写到无关设置。
 *
 * 空字符串按「未提供」处理，回落到已保存值。原因：密钥类字段（webhook_url、
 * 各类密码）在表单里是脱敏展示的，未改动时前端拿到的就是空串；若把空串当成
 * 显式覆盖，一次测试就会把本来能用的配置判成未配置。测试场景不需要「显式清空」语义。
 *
 * 掩码预览串（如 `abcd********wxyz`）同样按「未提供」处理——它只是给人看的，
 * 拿它去连 Telegram/SMTP 必然失败，回落到已保存值才是用户要的行为。
 */
export function pickNotificationSettingOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const overrides: Record<string, string> = {};
  for (const key of NOTIFICATION_DISPATCH_SETTING_KEYS) {
    const raw = source[key];
    if (typeof raw === 'string') {
      if (raw.trim() === '') continue;
      if (isMaskedSecretPreview(raw)) continue;
      overrides[key] = raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      overrides[key] = String(raw);
    }
  }
  return overrides;
}

type HealthStatus = 'ok' | 'warning' | 'error' | 'disabled';

type RecordHealth = (
  database: db.QueryDatabase | undefined,
  component: StoredHealthComponent,
  status: HealthStatus,
  detail?: unknown,
  options?: {
    auditAction?: string;
    auditUser?: string;
    auditLevel?: string;
    auditThrottleMs?: number;
    successThrottleMs?: number;
    nowMs?: number;
  },
) => Promise<void>;

type TelegramSender = typeof sendTelegramMessage;
type EmailSender = typeof sendSmtpEmail;
type WebhookSender = typeof sendWebhookMessage;

type DispatchDependencies = {
  sendTelegram?: TelegramSender;
  sendEmail?: EmailSender;
  sendWebhook?: WebhookSender;
  recordHealth?: RecordHealth;
};

type DispatchOptions = {
  channel?: string;
  auditUser?: string;
  deps?: DispatchDependencies;
};

type NotificationSettings = Record<string, string | undefined>;

function errorDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? '');
  return value.replace(/\s+/g, ' ').trim().slice(0, 700);
}

function webhookFormat(value: string | undefined): WebhookFormat {
  return value === 'slack' ||
    value === 'discord' ||
    value === 'feishu' ||
    value === 'dingtalk' ||
    value === 'wecom' ||
    value === 'custom'
    ? value
    : 'generic';
}

async function record(
  deps: DispatchDependencies,
  database: db.QueryDatabase | undefined,
  component: StoredHealthComponent,
  status: HealthStatus,
  detail?: unknown,
  options?: Parameters<RecordHealth>[4],
): Promise<void> {
  if (deps.recordHealth) await deps.recordHealth(database, component, status, detail, options);
}

async function dispatchTelegram(
  database: db.QueryDatabase | undefined,
  settings: NotificationSettings,
  notification: NotificationMessage,
  deps: DispatchDependencies,
  auditUser?: string,
): Promise<boolean> {
  const botToken = settings.telegram_bot_token || '';
  const chatId = settings.telegram_chat_id || '';
  if (!botToken || !chatId) {
    await record(deps, database, 'telegram', 'disabled', 'telegram credentials are not configured');
    return false;
  }
  try {
    const response = await (deps.sendTelegram || sendTelegramMessage)(botToken, {
      chat_id: chatId,
      text: formatTelegramHtmlText(notification.body),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (response.body) await response.body.cancel().catch(() => undefined);
    if (!response.ok) {
      await record(deps, database, 'telegram', 'error', `Telegram HTTP ${response.status}`, {
        auditAction: 'telegram_error',
        auditUser,
      });
      return false;
    }
    await record(deps, database, 'telegram', 'ok', 'Telegram message sent', { successThrottleMs: 60 * 60 * 1000 });
    return true;
  } catch (error) {
    if (error instanceof ScheduledBudgetExceeded) throw error;
    await record(deps, database, 'telegram', 'error', `Telegram send failed: ${errorDetail(error)}`, {
      auditAction: 'telegram_error',
      auditUser,
    });
    return false;
  }
}

async function dispatchEmail(
  database: db.QueryDatabase | undefined,
  settings: NotificationSettings,
  notification: NotificationMessage,
  deps: DispatchDependencies,
  auditUser?: string,
): Promise<boolean> {
  try {
    currentScheduledBudget()?.ensureCanStart(2);
    consumeScheduledSubrequests(2); // Socket plus possible STARTTLS upgrade; conservative for implicit TLS.
    const config: SmtpConfig = {
      host: settings.email_smtp_host || '',
      port: Number(settings.email_smtp_port || 587),
      security: settings.email_smtp_security === 'tls' ? 'tls' : 'starttls',
      username: settings.email_smtp_username || '',
      password: settings.email_smtp_password || '',
      fromAddress: settings.email_smtp_from_address || '',
      fromName: settings.email_smtp_from_name || 'CF VPS Monitor',
      recipients: normalizeRecipients(settings.email_smtp_recipients || ''),
      authMethod: settings.email_smtp_auth_method === 'login' ? 'login' : 'plain',
    };
    const result: SmtpResult = await (deps.sendEmail || sendSmtpEmail)(config, notification.subject, notification.body);
    if (result.ok) {
      await record(deps, database, 'email', 'ok', 'SMTP notification sent', { successThrottleMs: 60 * 60 * 1000 });
      return true;
    }
    await record(deps, database, 'email', 'error', `SMTP send failed: ${result.error}`, {
      auditAction: 'email_error',
      auditUser,
    });
  } catch (error) {
    if (error instanceof ScheduledBudgetExceeded) throw error;
    await record(deps, database, 'email', 'error', `SMTP send failed: ${errorDetail(error)}`, {
      auditAction: 'email_error',
      auditUser,
    });
  }
  return false;
}

async function dispatchWebhook(
  database: db.QueryDatabase | undefined,
  settings: NotificationSettings,
  notification: NotificationMessage,
  deps: DispatchDependencies,
  auditUser?: string,
): Promise<boolean> {
  const url = settings.webhook_url || '';
  if (!url) {
    await record(deps, database, 'webhook', 'disabled', 'webhook url is not configured');
    return false;
  }
  const result: WebhookSendResult = await (deps.sendWebhook || sendWebhookMessage)({
    url,
    format: webhookFormat(settings.webhook_format),
    secret: settings.webhook_secret || undefined,
    method: settings.webhook_method || undefined,
    contentType: settings.webhook_content_type || undefined,
    headersJson: settings.webhook_headers_json || undefined,
    bodyTemplate: settings.webhook_body_template || undefined,
    username: settings.webhook_username || undefined,
    password: settings.webhook_password || undefined,
    retryCount: Number(settings.webhook_retry_count || 1),
  }, notification);
  if (result.ok) {
    await record(deps, database, 'webhook', 'ok', `Webhook notification sent: host=${result.host}; status=${result.status}`, {
      successThrottleMs: 60 * 60 * 1000,
    });
    return true;
  }
  await record(
    deps,
    database,
    'webhook',
    'error',
    `Webhook send failed: host=${result.host || 'unknown'}; status=${result.status ?? 'unknown'}; error=${result.error}`,
    { auditAction: 'webhook_error', auditUser },
  );
  return false;
}

export async function dispatchNotification(
  database: db.QueryDatabase | undefined,
  settings: NotificationSettings,
  notification: NotificationMessage,
  options: DispatchOptions = {},
): Promise<boolean> {
  const deps = options.deps || {};
  const channel = options.channel || settings.notification_method || 'telegram';
  switch (channel) {
    case 'none':
      await record(deps, database, 'notification', 'disabled', 'notification_method is none');
      return false;
    case 'email':
      return dispatchEmail(database, settings, notification, deps, options.auditUser);
    case 'webhook':
      return dispatchWebhook(database, settings, notification, deps, options.auditUser);
    case 'telegram':
    default:
      return dispatchTelegram(database, settings, notification, deps, options.auditUser);
  }
}
