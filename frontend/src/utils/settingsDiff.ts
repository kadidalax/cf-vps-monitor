export type SettingsMap = Record<string, string>;

export function getChangedSettings(
  current: SettingsMap,
  original: SettingsMap,
  keys: readonly string[] = Object.keys(current),
): SettingsMap {
  const changed: SettingsMap = {};

  for (const key of keys) {
    if (current[key] !== original[key]) {
      changed[key] = current[key] ?? '';
    }
  }

  return changed;
}
