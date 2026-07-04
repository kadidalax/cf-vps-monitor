export const displayThemes = ['monitor', 'next'] as const;

export type DisplayTheme = typeof displayThemes[number];

export const defaultDisplayTheme: DisplayTheme = 'monitor';

const legacyDisplayThemeMap: Record<string, DisplayTheme> = {
  'cf-monitor': 'next',
};

export function normalizeDisplayTheme(value: unknown): DisplayTheme {
  if (typeof value === 'string' && legacyDisplayThemeMap[value]) {
    return legacyDisplayThemeMap[value];
  }

  return displayThemes.includes(value as DisplayTheme)
    ? (value as DisplayTheme)
    : defaultDisplayTheme;
}

export function getNextDisplayTheme(theme: DisplayTheme): DisplayTheme {
  return theme === 'monitor' ? 'next' : 'monitor';
}
