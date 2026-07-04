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

function smtpSuccess(line: string): boolean {
  return /^[23]\d\d/.test(line);
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
  const greeting = await io.readLine();
  if (!smtpSuccess(greeting)) return { ok: false, error: 'SMTP 服务不可用' };

  await io.writeLine(`EHLO ${config.host}`);
  if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP EHLO 失败' };

  if (config.authMethod === 'login') {
    await io.writeLine('AUTH LOGIN');
    await io.readLine();
    await io.writeLine(utf8Base64(config.username));
    await io.readLine();
    await io.writeLine(utf8Base64(config.password));
    if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP 认证失败' };
  } else {
    await io.writeLine(`AUTH PLAIN ${utf8Base64(`\0${config.username}\0${config.password}`)}`);
    if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP 认证失败' };
  }

  await io.writeLine(`MAIL FROM:<${config.fromAddress}>`);
  if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP 发件人被拒绝' };

  for (const recipient of config.recipients) {
    await io.writeLine(`RCPT TO:<${recipient}>`);
    if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP 收件人被拒绝' };
  }

  await io.writeLine('DATA');
  if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP DATA 失败' };
  await io.writeData(`${dotStuff(buildEmailMessage({
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    recipients: config.recipients,
    subject,
    body,
    host: config.host,
  }))}\r\n.`);
  if (!smtpSuccess(await io.readLine())) return { ok: false, error: 'SMTP 邮件内容被拒绝' };

  await io.writeLine('QUIT');
  return { ok: true };
}

async function readSmtpLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): Promise<string> {
  let text = '';
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text.split(/\r?\n/)[0] || '';
}

export async function sendSmtpEmail(config: SmtpConfig, subject: string, body: string): Promise<SmtpResult> {
  validateSmtpConfig(config);
  if (!config.username || !config.password) return { ok: false, error: 'SMTP 用户名或密码未配置' };
  if (!config.fromAddress) return { ok: false, error: '发件人未配置' };
  if (config.recipients.length === 0) return { ok: false, error: '收件地址未配置' };

  const { connect } = await import('cloudflare:sockets');
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.security === 'tls' ? 'on' : 'starttls', allowHalfOpen: false },
  );
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<SmtpResult>((resolve) => {
    timeoutId = setTimeout(() => {
      try { socket.close(); } catch {}
      resolve({ ok: false, error: 'SMTP 连接超时' });
    }, SMTP_FETCH_TIMEOUT_MS);
  });

  const send = (async () => {
    try {
      return await sendSmtpCommands({
        readLine: () => readSmtpLine(reader, decoder),
        writeLine: line => writer.write(encoder.encode(`${line}\r\n`)),
        writeData: data => writer.write(encoder.encode(`${data}\r\n`)),
      }, config, subject, body);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      try { await writer.close(); } catch {}
      try { socket.close(); } catch {}
    }
  })();

  return Promise.race([send, timeout]);
}
