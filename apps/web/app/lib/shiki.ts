import type { Highlighter } from "shiki";

/*
 * Lazy, single-instance Shiki highlighter for the Soul Explorer file viewer. Shiki (and its
 * oniguruma WASM) is dynamically imported so it stays out of the main bundle — loaded only when
 * the Soul tab opens a file.
 */

const THEMES = { light: "github-light", dark: "github-dark" } as const;
const LANGS = ["yaml", "markdown", "typescript", "json", "bash"] as const;

let instance: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!instance) {
    instance = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [...LANGS] })
    );
  }
  return instance;
}

export async function highlight(
  code: string,
  lang: string,
  theme: "light" | "dark"
): Promise<string> {
  const hl = await getHighlighter();
  const safeLang = (LANGS as readonly string[]).includes(lang) ? lang : "plaintext";
  return hl.codeToHtml(code, { lang: safeLang, theme: THEMES[theme] });
}
