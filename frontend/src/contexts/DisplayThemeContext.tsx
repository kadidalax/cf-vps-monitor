import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  defaultDisplayTheme,
  DisplayTheme,
  getNextDisplayTheme,
  normalizeDisplayTheme,
} from '../utils/displayTheme';
import { getLocalStorageItem, setLocalStorageItem } from '../utils/browserStorage';

interface DisplayThemeContextType {
  displayTheme: DisplayTheme;
  setDisplayTheme: (theme: DisplayTheme) => void;
  setDisplayThemeFromSettings: (theme: DisplayTheme) => void;
  toggleDisplayTheme: () => void;
}

const STORAGE_KEY = 'cf-monitor-display-theme';
const DISPLAY_THEME_SOURCE_KEY = 'cf-monitor-display-theme-source';

const DisplayThemeContext = createContext<DisplayThemeContextType>({
  displayTheme: defaultDisplayTheme,
  setDisplayTheme: () => {},
  setDisplayThemeFromSettings: () => {},
  toggleDisplayTheme: () => {},
});

export function useDisplayTheme() {
  return useContext(DisplayThemeContext);
}

function applyDisplayTheme(theme: DisplayTheme) {
  document.documentElement.setAttribute('data-monitor-theme', theme);
  const setter = (window as any).__setRadixAccentColor;
  if (setter) setter(theme);
}

function storeDisplayTheme(theme: DisplayTheme, source: 'local' | 'server') {
  setLocalStorageItem(STORAGE_KEY, theme);
  setLocalStorageItem(DISPLAY_THEME_SOURCE_KEY, source);
}

export function hasLocalDisplayThemePreference() {
  return getLocalStorageItem(DISPLAY_THEME_SOURCE_KEY) === 'local';
}

export function DisplayThemeProvider({ children }: { children: React.ReactNode }) {
  const [displayTheme, setDisplayThemeState] = useState<DisplayTheme>(() => {
    return normalizeDisplayTheme(getLocalStorageItem(STORAGE_KEY));
  });

  useEffect(() => {
    applyDisplayTheme(displayTheme);
  }, [displayTheme]);

  const setDisplayTheme = useCallback((theme: DisplayTheme) => {
    setDisplayThemeState(theme);
    storeDisplayTheme(theme, 'local');
    applyDisplayTheme(theme);
  }, []);

  const setDisplayThemeFromSettings = useCallback((theme: DisplayTheme) => {
    setDisplayThemeState(theme);
    storeDisplayTheme(theme, 'server');
    applyDisplayTheme(theme);
  }, []);

  const toggleDisplayTheme = useCallback(() => {
    setDisplayThemeState((current) => {
      const next = getNextDisplayTheme(current);
      storeDisplayTheme(next, 'local');
      applyDisplayTheme(next);
      return next;
    });
  }, []);

  return (
    <DisplayThemeContext.Provider value={{ displayTheme, setDisplayTheme, setDisplayThemeFromSettings, toggleDisplayTheme }}>
      {children}
    </DisplayThemeContext.Provider>
  );
}
