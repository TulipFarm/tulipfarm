export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];

const storageKey = 'tulipfarm.theme';

function isTheme(value: unknown): value is Theme {
  return themes.some(theme => theme === value);
}

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    return;
  }
}
