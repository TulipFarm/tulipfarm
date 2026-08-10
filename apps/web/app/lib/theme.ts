/**
 * Theme preference.
 *
 * Three choices, two outcomes: "system" is a standing instruction to follow the OS, not a third
 * palette. It is stored explicitly rather than as an absent key so that choosing it is a decision
 * the app can read back, and so a later "reset" can be told apart from "never chose".
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

export function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function readThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

/**
 * What is on screen right now.
 *
 * Read from the DOM rather than recomputed from the preference: the attribute is what the person
 * is actually looking at, so a toggle that flips it can never disagree with what they see.
 */
export function currentTheme(): ResolvedTheme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "dark" || attr === "light" ? attr : resolveTheme(readThemePreference());
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * Apply a preference and tell every other mounted control about it.
 *
 * The rail toggle and the Appearance page are two views of one value, so the writer broadcasts
 * rather than each reader polling.
 */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.setAttribute("data-theme", resolved);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private-mode storage failures must not stop the theme from applying for this session.
  }
  window.dispatchEvent(new Event("themechange"));
  return resolved;
}
