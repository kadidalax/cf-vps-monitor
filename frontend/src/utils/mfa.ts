export type MfaMethod = 'totp' | 'recovery_code';

export type AuthUser = {
  uuid: string;
  username: string;
};

export type LoginResult =
  | { kind: 'success'; user: AuthUser }
  | { kind: 'mfa_required'; challenge: string; methods: MfaMethod[] }
  | { kind: 'error'; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function parseLoginResponse(status: number, payload: unknown): LoginResult {
  const data = asRecord(payload) || {};
  const user = asRecord(data.user);
  if (
    status >= 200 && status < 300 &&
    typeof user?.uuid === 'string' &&
    typeof user.username === 'string'
  ) {
    return { kind: 'success', user: { uuid: user.uuid, username: user.username } };
  }
  if (
    status >= 200 && status < 300 &&
    data.code === 'MFA_REQUIRED' &&
    typeof data.challenge === 'string' &&
    data.challenge
  ) {
    const methods = Array.isArray(data.methods)
      ? data.methods.filter((method): method is MfaMethod => method === 'totp' || method === 'recovery_code')
      : [];
    return { kind: 'mfa_required', challenge: data.challenge, methods };
  }
  return { kind: 'error', error: typeof data.error === 'string' ? data.error : '登录失败' };
}

export function normalizeMfaCode(value: string, method: MfaMethod): string | null {
  if (method === 'totp') {
    const code = value.replace(/\s/g, '');
    return /^\d{6}$/.test(code) ? code : null;
  }
  const raw = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{24}$/.test(raw)) return null;
  return raw.match(/.{4}/g)?.join('-') || null;
}

export function formatRecoveryCodesText(codes: string[], username: string): string {
  return [
    'CF VPS Monitor 双重身份验证恢复码',
    `账户: ${username}`,
    '',
    '每个恢复码只能使用一次。请离线安全保存。',
    '',
    ...codes,
    '',
  ].join('\n');
}

export function downloadRecoveryCodes(codes: string[], username: string): void {
  const blob = new Blob([formatRecoveryCodesText(codes, username)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cf-vps-monitor-recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}

export async function runWithMfaStepUpRetry<T extends { status: number }>(
  request: () => Promise<T>,
  stepUp: () => Promise<boolean>,
): Promise<T> {
  const first = await request();
  if (first.status !== 428 || !await stepUp()) return first;
  return request();
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
let pendingStepUp: Promise<boolean> | null = null;

export function registerMfaStepUpHandler(handler: StepUpHandler): () => void {
  stepUpHandler = handler;
  return () => {
    if (stepUpHandler === handler) stepUpHandler = null;
  };
}

export function requestMfaStepUp(): Promise<boolean> {
  if (pendingStepUp) return pendingStepUp;
  if (!stepUpHandler) return Promise.resolve(false);
  pendingStepUp = stepUpHandler().finally(() => {
    pendingStepUp = null;
  });
  return pendingStepUp;
}