export const TELEGRAM_MESSAGE_MAX_CHARS = 4096;
export const TELEGRAM_FETCH_TIMEOUT_MS = 5000;

type TelegramSendMessagePayload = {
  chat_id: string;
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview?: boolean;
};

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTelegramHtmlText(value: unknown): string {
  return escapeTelegramHtml(String(value ?? '').slice(0, TELEGRAM_MESSAGE_MAX_CHARS));
}

export async function sendTelegramMessage(botToken: string, payload: TelegramSendMessagePayload): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
