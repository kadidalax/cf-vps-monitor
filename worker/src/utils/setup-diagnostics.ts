const MAX_DETAIL_LENGTH = 700;
const SECRET_DETAIL_KEY_PATTERN = [
  'access_token',
  'admin_password',
  'api[_-]?key',
  'api[_-]?token',
  'client_secret',
  'database_url',
  'jwt_secret',
  'password',
  'private_key',
  'secret',
  'service_role',
  'supabase[_-]?service[_-]?role[_-]?key',
  'settings_encryption_key',
  'telegram_bot_token',
  'telegram_chat_id',
  'token',
  'token_hash',
  'viewer_token',
].join('|');
const SECRET_QUERY_PARAM_PATTERN = [
  'access_token',
  'api_key',
  'key',
  'password',
  'secret',
  'token',
  'token_hash',
  'viewer_token',
].join('|');
const secretQuotedValuePattern = new RegExp(
  `((?:^|[\\s{,;])["']?(?:${SECRET_DETAIL_KEY_PATTERN})["']?\\s*[:=]\\s*["'])[^"']+(["'])`,
  'gi',
);
const secretBareValuePattern = new RegExp(
  `((?:^|[\\s{,;])["']?(?:${SECRET_DETAIL_KEY_PATTERN})["']?\\s*[:=]\\s*)[^\\s,;}"']+`,
  'gi',
);
const secretQueryParamPattern = new RegExp(
  `([?&](?:${SECRET_QUERY_PARAM_PATTERN})=)[^&\\s"']+`,
  'gi',
);

export function redactDatabaseSecrets(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DATABASE_CONNECTION]')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(secretQueryParamPattern, '$1[REDACTED]')
    .replace(secretQuotedValuePattern, '$1[REDACTED]$2')
    .replace(secretBareValuePattern, '$1[REDACTED]');
}

function errorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message || value.name : String(value ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}

export function sanitizeSetupDiagnosticDetail(value: unknown): string {
  return redactDatabaseSecrets(errorMessage(value));
}
