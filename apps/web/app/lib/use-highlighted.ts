import { useEffect, useState } from "react";

function readTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Shiki-highlighted HTML for `code`, re-rendered when the app theme changes.
 *
 * Returns `null` while the highlighter is still loading and whenever it fails, so a caller can
 * fall back to plain text rather than showing nothing — the grammars arrive in a lazy chunk, and
 * an unreadable pane is a worse outcome than an unstyled one.
 */
export function useHighlighted(code: string | null, lang: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(readTheme);

  useEffect(() => {
    const read = () => setTheme(readTheme());
    window.addEventListener("themechange", read);
    return () => window.removeEventListener("themechange", read);
  }, []);

  useEffect(() => {
    if (code === null) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    import("./shiki")
      .then(({ highlight }) => highlight(code, lang, theme))
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  return html;
}
