import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
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
  logout: () => Promise<void>;
  clearAuth: () => void;
  updateUser: (nextUser: Partial<User>) => void;
  isAuthenticated: boolean;
  authLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => ({ kind: 'error', error: '登录不可用' }),
  completeMfaLogin: async () => ({ kind: 'error', error: '登录不可用' }),
  logout: async () => {},
  clearAuth: () => {},
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
  const authRevisionRef = useRef(0);
  const logoutRequestRef = useRef<Promise<void> | null>(null);

  const clearAuth = useCallback(() => {
    authRevisionRef.current += 1;
    clearStoredUser();
    setUser(null);
    setAuthLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revision = authRevisionRef.current;
    const isCurrent = () => !cancelled && authRevisionRef.current === revision;
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
        if (isCurrent() && nextUser) {
          writeStoredUser(nextUser);
          setUser((current) => current && current.uuid === nextUser.uuid && current.username === nextUser.username ? current : nextUser);
        } else if (isCurrent()) {
          clearAuth();
        }
      })
      .catch(() => {
        if (isCurrent()) clearAuth();
      })
      .finally(() => {
        if (isCurrent()) setAuthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  const finishLogin = useCallback((result: LoginResult): LoginResult => {
    if (result.kind !== 'success') return result;
    const nextUser = normalizeAuthUser(result.user);
    if (!nextUser) return { kind: 'error', error: '登录响应无效' };
    authRevisionRef.current += 1;
    writeStoredUser(nextUser);
    setUser(nextUser);
    setAuthLoading(false);
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
    if (logoutRequestRef.current) return logoutRequestRef.current;
    authRevisionRef.current += 1;
    const request = (async () => {
      const headers = new Headers();
      const csrfToken = readCookie(CSRF_COOKIE_NAME);
      if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
      const response = await fetch(`${API_BASE}/logout`, { method: 'POST', credentials: 'same-origin', headers });
      const data = await readJson(response);
      if (!response.ok || data.success !== true) throw new Error(data.error || `退出失败（HTTP ${response.status}）`);
      clearAuth();
    })().finally(() => {
      if (logoutRequestRef.current === request) logoutRequestRef.current = null;
    });
    logoutRequestRef.current = request;
    return request;
  }, [clearAuth]);

  const updateUser = useCallback((nextUser: Partial<User>) => {
    authRevisionRef.current += 1;
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
      clearAuth,
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

export function useApiResponse() {
  const { clearAuth } = useAuth();

  const apiFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await runWithMfaStepUpRetry(
      async () => {
        const { url, init } = buildApiRequest(path, options);
        return fetch(url, init);
      },
      requestMfaStepUp,
    );
    if (!res.ok) {
      const data = await readJson(res);
      if (shouldClearAuthForStatus(res.status)) {
        clearAuth();
      }
      const details = Array.isArray(data.details) ? `: ${data.details.join('；')}` : '';
      throw new Error(data.error ? `${data.error}${details}` : `HTTP ${res.status}`);
    }

    return res;
  }, [clearAuth]);

  return apiFetch;
}

export function useApi() {
  const apiResponseFetch = useApiResponse();
  return useCallback(async (path: string, options: RequestInit = {}) => {
    return readJson(await apiResponseFetch(path, options));
  }, [apiResponseFetch]);
}
