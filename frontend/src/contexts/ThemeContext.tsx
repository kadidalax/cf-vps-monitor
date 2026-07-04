import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getLocalStorageItem, setLocalStorageItem } from '../utils/browserStorage';
import { applyThemeClass, defaultThemeMode, normalizeThemeMode } from '../utils/themeAppearance';
import type { ThemeMode } from '../utils/themeAppearance';

interface ThemeContextType {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: defaultThemeMode,
  setTheme: () => {},
  isDark: true,
});

export const useTheme = () => useContext(ThemeContext);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() =>
    normalizeThemeMode(getLocalStorageItem('cf-monitor-theme')),
  );

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const isDark = theme === 'system' ? systemDark : theme === 'dark';

  useEffect(() => {
    applyThemeClass(document.documentElement, theme, systemDark);
  }, [theme, systemDark]);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    setLocalStorageItem('cf-monitor-theme', t);
    // 更新 Radix Theme appearance
    const setter = (window as any).__setThemeAppearance;
    if (setter) setter(t);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isDark }}>
      {children}
    </ThemeContext.Provider>
  );
}
