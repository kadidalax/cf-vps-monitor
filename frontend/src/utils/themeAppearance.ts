export type ThemeMode = 'light' | 'dark' | 'system';
export type ExplicitThemeAppearance = 'light' | 'dark';

export const defaultThemeMode: ThemeMode = 'dark';

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : defaultThemeMode;
}

export function getExplicitThemeAppearance(theme: ThemeMode): ExplicitThemeAppearance | undefined {
  return theme === 'system' ? undefined : theme;
}

export function applyThemeClass(
  element: Pick<Element, 'classList'>,
  theme: ThemeMode,
  systemDark: boolean,
) {
  element.classList.remove('light', 'dark');
  element.classList.add(theme === 'system' ? (systemDark ? 'dark' : 'light') : theme);
}
