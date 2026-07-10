import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { getSessionStorageItem, removeSessionStorageItem, setSessionStorageItem } from '../utils/browserStorage';
import { API_BASE, CSRF_COOKIE_NAME, buildApiRequest, readCookie } from '../utils/api';
import {
  parseLoginResponse,
  requestMfaStepUp,
  runWithMfaStepUpRetry,
  type LoginResult,
  type MfaMethod,
} from '../utils/mfa';
import { normalizeAuthUser, shouldCheckAdminSessionOnLoad, shouldClearAuthForStatus, type User } from './auth-state';

interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<LoginResult>;
  completeMfaLogin: (challenge: string, method: MfaMethod, code: string) => Promise<LoginResult>;
  logout: () => void;
  updateUser: (nextUser: Partial<User>) => void;
  isAuthenticated: boolean;
  authLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => ({ kind: 'error', error: '登录不可用' }),
  completeMfaLogin: async () => ({ kind: 'error', error: '登录不可用' }),
  logout: () => {},
  updateUser: () => {},
  isAuthenticated: false,
  authLoading: true,
});

const AUTH_USER_STORAGE_KEY = 'cf_monitor_user';

async function readJson(res: Response) {
  return res.json().catch(() => ({}));
}

function readStoredUser(): User | null {
  try {
    const raw = getSessionStorageItem(AUTH_USER_STORAGE_KEY);
    return raw ? normalizeAuthUser(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeStoredUser(user: User): void {
  setSessionStorageItem(AUTH_USER_STORAGE_KEY, JSON.stringify(user));
}

function clearStoredUser(): void {
  removeSessionStorageItem(AUTH_USER_STORAGE_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initialUser = readStoredUser();
  const [user, setUser] = useState<User | null>(initialUser);
  const [authLoading, setAuthLoading] = useState(true);

  const clearAuth = useCallback(() => {
    clearStoredUser();
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pathname = typeof window === 'undefined' ? '/' : window.location.pathname;
    const shouldCheckSession = shouldCheckAdminSessionOnLoad(pathname);
    if (!shouldCheckSession) {
      setAuthLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setAuthLoading(true);

    fetch(`${API_BASE}/me`, {
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const data = await readJson(res);
        const nextUser = normalizeAuthUser(data);
        if (!res.ok || !nextUser) {
          throw new Error(data.error || 'Invalid session');
        }
        return nextUser;
      })
      .then((nextUser) => {
        if (!cancelled && nextUser) {
          writeStoredUser(nextUser);
          setUser((current) => current && current.uuid === nextUser.uuid && current.username === nextUser.username ? current : nextUser);
        } else if (!cancelled) {
          clearAuth();
        }
      })
      .catch(() => {
        if (!cancelled) clearAuth();
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  const finishLogin = useCallback((result: LoginResult): LoginResult => {
    if (result.kind !== 'success') return result;
    const nextUser = normalizeAuthUser(result.user);
    if (!nextUser) return { kind: 'error', error: '登录响应无效' };
    writeStoredUser(nextUser);
    setUser(nextUser);
    return { kind: 'success', user: nextUser };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      return finishLogin(parseLoginResponse(res.status, await readJson(res)));
    } catch {
      return { kind: 'error', error: '网络错误' };
    }
  }, [finishLogin]);

  const completeMfaLogin = useCallback(async (
    challenge: string,
    method: MfaMethod,
    code: string,
  ): Promise<LoginResult> => {
    try {
      const res = await fetch(`${API_BASE}/login/mfa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ challenge, method, code }),
      });
      return finishLogin(parseLoginResponse(res.status, await readJson(res)));
    } catch {
      return { kind: 'error', error: '网络错误' };
    }
  }, [finishLogin]);

  const logout = useCallback(() => {
    clearAuth();
    const headers = new Headers();
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }
    fetch(`${API_BASE}/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
    }).catch(() => {});
  }, [clearAuth]);

  const updateUser = useCallback((nextUser: Partial<User>) => {
    setUser((current) => {
      if (!current) return current;
      const updated = { ...current, ...nextUser };
      writeStoredUser(updated);
      return updated;
    });
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      login,
      completeMfaLogin,
      logout,
      updateUser,
      isAuthenticated: !!user,
      authLoading,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function useApi() {
  const { logout } = useAuth();

  const apiFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await runWithMfaStepUpRetry(
      async () => {
        const { url, init } = buildApiRequest(path, options);
        return fetch(url, init);
      },
      requestMfaStepUp,
    );
    const data = await readJson(res);

    if (!res.ok) {
      if (shouldClearAuthForStatus(res.status)) {
        logout();
      }
      const details = Array.isArray(data.details) ? `: ${data.details.join('；')}` : '';
      throw new Error(data.error ? `${data.error}${details}` : `HTTP ${res.status}`);
    }

    return data;
  }, [logout]);

  return apiFetch;
}