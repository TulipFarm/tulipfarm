import { A2UI_COMPONENT_CSS } from "~/lib/a2ui/components";
import { A2UI_RUNTIME } from "~/lib/a2ui/runtime";

/**
 * Build the full HTML document injected into the A2UI iframe via `srcDoc`. The document is the
 * security envelope: a strict CSP (no external network; scripts limited to our per-render nonce),
 * the shared design tokens, a minimal reset, the in-iframe runtime, and the sanitized agent body.
 */

// Minimal, token-driven reset. System monospace — font-src 'none' blocks web-font fetches (D9).
const RESET = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html{color-scheme:light dark}",
  'body{margin:0;padding:12px;font-family:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,' +
    "monospace;font-size:14px;line-height:1.5;color:var(--foreground);background:var(--background)}",
].join("");

export function buildSrcdoc(input: {
  sanitizedHtml: string;
  tokensCss: string;
  theme: "light" | "dark";
  nonce: string;
}): string {
  const { sanitizedHtml, tokensCss, theme, nonce } = input;

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${tokensCss}</style>
<style>${RESET}</style>
<style>${A2UI_COMPONENT_CSS}</style>
<script nonce="${nonce}">${A2UI_RUNTIME}</script>
</head>
<body>${sanitizedHtml}</body>
</html>`;
}
