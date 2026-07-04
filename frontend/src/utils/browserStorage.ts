export function getLocalStorageItem(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setLocalStorageItem(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeLocalStorageItem(key: string): boolean {
  try {
    globalThis.localStorage?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function getSessionStorageItem(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setSessionStorageItem(key: string, value: string): boolean {
  try {
    globalThis.sessionStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSessionStorageItem(key: string): boolean {
  try {
    globalThis.sessionStorage?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
