import type { HighlighterCore } from "shiki/core";

/*
 * Lazy, single-instance Shiki highlighter for the Soul Explorer file viewer.
 *
 * Built on `shiki/core` with the five grammars and two themes this app actually uses. The bundled
 * `shiki` entry instead pulls the full registry, which makes Vite emit ~500 grammar chunks plus a
 * 600 kB Oniguruma WASM chunk. The JavaScript regex engine removes the WASM entirely; `forgiving`
 * downgrades a grammar pattern it cannot compile to no highlighting rather than throwing.
 */

const THEMES = { light: "github-light", dark: "github-dark" } as const;
const LANGS = ["yaml", "markdown", "typescript", "json", "bash"] as const;

let instance: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!instance) {
    instance = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@shikijs/themes/github-light"),
      import("@shikijs/themes/github-dark"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/langs/markdown"),
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/bash"),
    ]).then(([core, engine, light, dark, ...langs]) =>
      core.createHighlighterCore({
        themes: [light.default, dark.default],
        langs: langs.map((l) => l.default),
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
      })
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
