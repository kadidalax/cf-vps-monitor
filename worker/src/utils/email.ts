import { currentScheduledBudget, ScheduledBudgetExceeded } from './scheduled-budget.ts';

export const EMAIL_MESSAGE_MAX_CHARS = 4096;
export const EMAIL_SUBJECT_MAX_CHARS = 120;
export const SMTP_FETCH_TIMEOUT_MS = 8000;

export type SmtpSecurity = 'tls' | 'starttls';
export type SmtpAuthMethod = 'plain' | 'login';

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  recipients: string[];
  authMethod: SmtpAuthMethod;
};

export type SmtpResult = { ok: true } | { ok: false; error: string };

export type SmtpIo = {
  readLine: () => Promise<string>;
  writeLine: (line: string) => Promise<void>;
  writeData: (data: string) => Promise<void>;
  startTls?: () => Promise<void>;
};

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function isUnsafeHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !normalized ||
    normalized === 'localhost' ||
    /[\s/@:]/.test(normalized) ||
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd');
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function quoteDisplayName(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${utf8Base64(value.slice(0, EMAIL_SUBJECT_MAX_CHARS))}?=`;
}

export function normalizeRecipients(value: string): string[] {
  const recipients = value
    .split(/[;,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  if (recipients.length === 0) throw new Error('请填写至少一个收件地址');
  if (recipients.length > 20) throw new Error('收件地址不能超过 20 个');
  for (const recipient of recipients) {
    if (recipient.length > 254 || !EMAIL_PATTERN.test(recipient)) {
      throw new Error(`收件地址无效: ${recipient}`);
    }
  }
  return [...new Set(recipients)];
}

export function validateSmtpConfig(input: Pick<SmtpConfig, 'host' | 'port' | 'security'>): void {
  if (isUnsafeHost(input.host)) throw new Error('SMTP Host 无效');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('SMTP Port 无效');
  }
  if (input.port === 25) throw new Error('SMTP 端口 25 不可用，请使用 465 或 587');
  if (input.security !== 'tls' && input.security !== 'starttls') {
    throw new Error('SMTP 安全模式无效');
  }
}

export function buildEmailMessage(input: {
  fromAddress: string;
  fromName: string;
  recipients: string[];
  subject: string;
  body: string;
  host: string;
}): string {
  const subject = input.subject.slice(0, EMAIL_SUBJECT_MAX_CHARS);
  const body = input.body.slice(0, EMAIL_MESSAGE_MAX_CHARS);
  const from = input.fromName.trim()
    ? `${quoteDisplayName(input.fromName.trim())} <${input.fromAddress}>`
    : input.fromAddress;
  const headers = [
    `From: ${from}`,
    `To: ${input.recipients.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${input.host}>`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

const SMTP_MAX_REPLY_BYTES = 64 * 1024;
const SMTP_MAX_REPLY_LINES = 128;
const SMTP_MAX_LINE_BYTES = 512;

async function readSmtpReply(io: SmtpIo): Promise<{ code: number; lines: string[] }> {
  let code = 0;
  let totalBytes = 0;
  const lines: string[] = [];
  for (let index = 0; index < SMTP_MAX_REPLY_LINES; index += 1) {
    const line = await io.readLine();
    const bytes = new TextEncoder().encode(line).byteLength + 2;
    totalBytes += bytes;
    if (bytes > SMTP_MAX_LINE_BYTES || totalBytes > SMTP_MAX_REPLY_BYTES) throw new Error('SMTP reply exceeds limits');
    const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
    if (!match) throw new Error('Malformed SMTP reply');
    const current = Number(match[1]);
    if (index === 0) code = current;
    if (current !== code) throw new Error('Inconsistent multiline SMTP reply');
    lines.push(match[3] || '');
    if (match[2] !== '-') return { code, lines };
  }
  throw new Error('SMTP reply has too many lines');
}

function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, '$1..');
}

export async function sendSmtpCommands(
  io: SmtpIo,
  config: SmtpConfig,
  subject: string,
  body: string,
): Promise<SmtpResult> {
  if ((await readSmtpReply(io)).code !== 220) return { ok: false, error: 'SMTP 服务不可用' };

  await io.writeLine(`EHLO ${config.host}`);
  const hello = await readSmtpReply(io);
  if (hello.code !== 250) return { ok: false, error: 'SMTP EHLO 失败' };

  if (config.security === 'starttls') {
    if (!io.startTls) return { ok: false, error: 'SMTP 连接不支持 TLS 升级' };
    if (!hello.lines.some(line => /^STARTTLS(?:\s|$)/i.test(line))) return { ok: false, error: 'SMTP 服务未提供 STARTTLS' };
    await io.writeLine('STARTTLS');
    if ((await readSmtpReply(io)).code !== 220) return { ok: false, error: 'SMTP STARTTLS 被拒绝' };
    await io.startTls();
    // RFC 3207: capabilities obtained before TLS must be discarded.
    await io.writeLine(`EHLO ${config.host}`);
    if ((await readSmtpReply(io)).code !== 250) return { ok: false, error: 'SMTP TLS EHLO 失败' };
  }

  if (config.authMethod === 'login') {
    await io.writeLine('AUTH LOGIN');
    if ((await readSmtpReply(io)).code !== 334) return { ok: false, error: 'SMTP 认证请求被拒绝' };
    await io.writeLine(utf8Base64(config.username));
    if ((await readSmtpReply(io)).code !== 334) return { ok: false, error: 'SMTP 用户名被拒绝' };
    await io.writeLine(utf8Base64(config.password));
    if ((await readSmtpReply(io)).code !== 235) return { ok: false, error: 'SMTP 认证失败' };
  } else {
    await io.writeLine(`AUTH PLAIN ${utf8Base64(`\0${config.username}\0${config.password}`)}`);
    if ((await readSmtpReply(io)).code !== 235) return { ok: false, error: 'SMTP 认证失败' };
  }

  await io.writeLine(`MAIL FROM:<${config.fromAddress}>`);
  if ((await readSmtpReply(io)).code !== 250) return { ok: false, error: 'SMTP 发件人被拒绝' };

  for (const recipient of config.recipients) {
    await io.writeLine(`RCPT TO:<${recipient}>`);
    if (![250, 251, 252].includes((await readSmtpReply(io)).code)) return { ok: false, error: 'SMTP 收件人被拒绝' };
  }

  await io.writeLine('DATA');
  if ((await readSmtpReply(io)).code !== 354) return { ok: false, error: 'SMTP DATA 失败' };
  await io.writeData(`${dotStuff(buildEmailMessage({
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    recipients: config.recipients,
    subject,
    body,
    host: config.host,
  }))}\r\n.`);
  if ((await readSmtpReply(io)).code !== 250) return { ok: false, error: 'SMTP 邮件内容被拒绝' };

  // The final 250 commits acceptance. A subsequent disconnect must not cause
  // the notification queue to resend an already accepted message.
  try { void io.writeLine('QUIT').catch(() => {}); } catch {}
  return { ok: true };
}

function createSmtpLineReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  return async () => {
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        return line;
      }
      if (buffered.length >= SMTP_MAX_LINE_BYTES) throw new Error('SMTP line exceeds limits');
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SMTP connection closed before a complete reply');
      if (chunk.value.byteLength > SMTP_MAX_REPLY_BYTES) throw new Error('SMTP reply exceeds limits');
      buffered += decoder.decode(chunk.value, { stream: true });
      if (buffered.length > SMTP_MAX_REPLY_BYTES) throw new Error('SMTP reply exceeds limits');
    }
  };
}

export async function sendSmtpEmail(config: SmtpConfig, subject: string, body: string): Promise<SmtpResult> {
  validateSmtpConfig(config);
  if (!config.username || !config.password) return { ok: false, error: 'SMTP 用户名或密码未配置' };
  if (!config.fromAddress) return { ok: false, error: '发件人未配置' };
  if (config.recipients.length === 0) return { ok: false, error: '收件地址未配置' };

  const { connect } = await import('cloudflare:sockets');
  const budget = currentScheduledBudget();
  budget?.ensureCanStart(0);
  let socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.security === 'tls' ? 'on' : 'starttls', allowHalfOpen: false },
  );
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  let readLine = createSmtpLineReader(reader);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<SmtpResult>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      try { void socket.close().catch(() => {}); } catch {}
      if (budget && budget.remainingMs() <= 0) {
        reject(new ScheduledBudgetExceeded());
        return;
      }
      resolve({ ok: false, error: 'SMTP 连接超时' });
    }, Math.min(SMTP_FETCH_TIMEOUT_MS, budget?.remainingMs() ?? SMTP_FETCH_TIMEOUT_MS));
  });

  const send = (async () => {
    try {
      return await sendSmtpCommands({
        readLine: () => readLine(),
        writeLine: line => writer.write(encoder.encode(`${line}\r\n`)),
        writeData: data => writer.write(encoder.encode(`${data}\r\n`)),
        startTls: async () => {
          reader.releaseLock();
          writer.releaseLock();
          socket = socket.startTls();
          await socket.opened;
          reader = socket.readable.getReader();
          writer = socket.writable.getWriter();
          readLine = createSmtpLineReader(reader);
        },
      }, config, subject, body);
    } catch {
      return { ok: false, error: 'SMTP 连接或安全协商失败' } satisfies SmtpResult;
    } finally {
      try { reader.releaseLock(); } catch {}
      try { writer.releaseLock(); } catch {}
      try { await socket.close(); } catch {}
      if (timeoutId) clearTimeout(timeoutId);
    }
  })();

  return Promise.race([send, timeout]);
}
