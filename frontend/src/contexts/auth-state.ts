export interface User {
  uuid: string;
  username: string;
}

export function normalizeAuthUser(value: unknown): User | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const uuid = typeof record.uuid === 'string' ? record.uuid.trim() : '';
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  return uuid && username ? { uuid, username } : null;
}

export function shouldClearAuthForStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function shouldCheckAdminSessionOnLoad(_pathname: string): boolean {
  return true;
}
