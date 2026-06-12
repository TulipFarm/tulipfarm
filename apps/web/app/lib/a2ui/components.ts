/**
 * A2UI tf-* component styles, injected into the srcdoc iframe as an inline <style> (see srcdoc.ts).
 * Authored as a TS string constant — mirroring runtime.ts's A2UI_RUNTIME — so it is a real value in
 * every environment (app + Vitest) without a `?raw`/CSS transform. Tokens come from tokens.css
 * (already inlined in the <head>); this only references var(--token) + literal units — no external
 * resources, no web fonts, no SVG. Containers: radius 0; interactive: ~2px; hairline 1px borders;
 * no box-shadow; font inherited (system monospace). Variants/tones are palette-honest: neutral
 * (--muted/--secondary), brand (--primary, sparing), danger (--destructive) — no green/amber.
 */
export const A2UI_COMPONENT_CSS = `
/* tf-card — border is the only separator (light: --card ≈ --background). */
tf-card {
  display: block;
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
  padding: 12px 16px;
}

/* tf-grid — data-cols="N" explicit; default responsive auto-fit. */
tf-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}
tf-grid[data-cols="1"] { grid-template-columns: repeat(1, 1fr); }
tf-grid[data-cols="2"] { grid-template-columns: repeat(2, 1fr); }
tf-grid[data-cols="3"] { grid-template-columns: repeat(3, 1fr); }
tf-grid[data-cols="4"] { grid-template-columns: repeat(4, 1fr); }
tf-grid[data-cols="5"] { grid-template-columns: repeat(5, 1fr); }
tf-grid[data-cols="6"] { grid-template-columns: repeat(6, 1fr); }

/* tf-heading — default bold; data-variant="label" = the [section] label style. */
tf-heading {
  display: block;
  font-weight: 700;
  color: var(--foreground);
  margin: 0 0 8px;
}
tf-heading[data-variant="label"] {
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.2em;
  color: var(--muted-foreground);
}
tf-heading[data-variant="label"]::before { content: "["; color: var(--primary); }
tf-heading[data-variant="label"]::after { content: "]"; color: var(--primary); }

/* tf-text */
tf-text {
  display: block;
  color: var(--foreground);
  margin: 0 0 4px;
}
tf-text[data-tone="muted"] { color: var(--muted-foreground); }
tf-text[data-tone="brand"] { color: var(--primary); }
tf-text[data-tone="danger"] { color: var(--destructive); }
tf-text[data-size="xs"] { font-size: 0.75rem; }
tf-text[data-size="sm"] { font-size: 0.875rem; }
tf-text[data-size="base"] { font-size: 1rem; }

/* tf-badge — default = neutral. */
tf-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
  background: var(--secondary);
  color: var(--secondary-foreground);
  border: 1px solid transparent;
}
tf-badge[data-variant="brand"] {
  background: var(--primary);
  color: var(--primary-foreground);
}
tf-badge[data-variant="danger"] {
  background: var(--destructive);
  color: var(--destructive-foreground);
}
tf-badge[data-variant="outline"] {
  background: transparent;
  color: var(--foreground);
  border-color: var(--border);
}

/* tf-alert — tone via border + text color (shell-consistent, no icon dependency). */
tf-alert {
  display: block;
  padding: 10px 12px;
  border: 1px solid var(--border);
  background: var(--muted);
  color: var(--foreground);
  font-size: 0.875rem;
}
tf-alert [data-slot="title"] {
  display: block;
  font-weight: 700;
  margin-bottom: 2px;
}
tf-alert[data-tone="danger"] {
  background: color-mix(in oklch, var(--destructive) 10%, var(--background));
  border-color: var(--destructive);
}
tf-alert[data-tone="danger"] [data-slot="title"] {
  color: var(--destructive);
}
tf-alert[data-tone="brand"] {
  background: color-mix(in oklch, var(--primary) 8%, var(--background));
  border-color: var(--primary);
}

/* tf-empty-state — centered; no animation dep. */
tf-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 32px 24px;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
tf-empty-state [data-slot="title"] {
  font-size: 1rem;
  font-weight: 700;
  color: var(--foreground);
}

/* tf-list — bordered; canonical <ul><li> rows with hairline dividers. */
tf-list {
  display: block;
  border: 1px solid var(--border);
  font-size: 0.875rem;
}
tf-list ul,
tf-list ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
tf-list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  color: var(--foreground);
}
tf-list li + li {
  border-top: 1px solid var(--border);
}
tf-list [data-slot="meta"] {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  margin-left: auto;
  white-space: nowrap;
}

/* tf-metric-card — big value + label + trend delta (palette-honest). */
tf-metric-card {
  display: block;
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
  padding: 14px 16px;
}
tf-metric-card [data-slot="value"] {
  display: block;
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.1;
  color: var(--foreground);
}
tf-metric-card [data-slot="label"] {
  display: block;
  margin-top: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  color: var(--muted-foreground);
}
tf-metric-card [data-slot="delta"] {
  display: inline-block;
  margin-top: 6px;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}
tf-metric-card[data-trend="up"] [data-slot="delta"]::before { content: "↑ "; color: var(--foreground); }
tf-metric-card[data-trend="flat"] [data-slot="delta"]::before { content: "→ "; color: var(--muted-foreground); }
tf-metric-card[data-trend="down"] [data-slot="delta"] { color: var(--destructive); }
tf-metric-card[data-trend="down"] [data-slot="delta"]::before { content: "↓ "; color: var(--destructive); }

/* tf-detail-view — key/value rows; native dl/dt/dd canonical + data-slot variant. */
tf-detail-view {
  display: block;
  border: 1px solid var(--border);
  font-size: 0.875rem;
}
tf-detail-view dl {
  margin: 0;
  padding: 0;
}
tf-detail-view dl > div,
tf-detail-view [data-slot="row"] {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}
tf-detail-view dl > div:first-child,
tf-detail-view [data-slot="row"]:first-child {
  border-top: none;
}
tf-detail-view dt,
tf-detail-view [data-slot="label"] {
  color: var(--muted-foreground);
  word-break: break-word;
}
tf-detail-view dd,
tf-detail-view [data-slot="value"] {
  margin: 0;
  min-width: 0;
  color: var(--foreground);
  word-break: break-word;
}

/* tf-button — flat, styled like ui/button.tsx; DISPLAY-ONLY (no JS). */
tf-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 36px;
  padding: 8px 16px;
  border: none;
  border-radius: 2px;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  text-decoration: none;
  background: var(--primary);
  color: var(--primary-foreground);
  transition: background 120ms ease, color 120ms ease;
}
tf-button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
tf-button:not([data-variant]):hover,
tf-button[data-variant="default"]:hover {
  background: color-mix(in oklch, var(--primary) 90%, transparent);
}
tf-button[data-variant="secondary"] {
  background: var(--secondary);
  color: var(--secondary-foreground);
}
tf-button[data-variant="secondary"]:hover {
  background: color-mix(in oklch, var(--secondary) 80%, transparent);
}
tf-button[data-variant="outline"] {
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--input);
}
tf-button[data-variant="outline"]:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}
tf-button[data-variant="ghost"] {
  background: transparent;
  color: var(--foreground);
}
tf-button[data-variant="ghost"]:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}
tf-button[data-variant="destructive"] {
  background: var(--destructive);
  color: var(--destructive-foreground);
}
tf-button[data-variant="destructive"]:hover {
  background: color-mix(in oklch, var(--destructive) 90%, transparent);
}
tf-button[data-variant="link"] {
  height: auto;
  padding: 0;
  background: transparent;
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 4px;
}
tf-button[data-size="sm"] {
  height: 32px;
  padding: 6px 12px;
  font-size: 0.8125rem;
}
tf-button[data-size="lg"] {
  height: 40px;
  padding: 8px 24px;
  font-size: 1rem;
}

/* tf-data-table — schema-shaped rows on a native <table>, styled flat to match schema-table.tsx.
   DISPLAY-ONLY: the sort glyph reflects the aria-sort the agent sets; real sort/filter/paginate lives
   in the shell list page (no iframe JS until A2UI-V1-001). */
tf-data-table {
  display: block;
  border: 1px solid var(--border);
  overflow-x: auto;
  font-size: 0.875rem;
}
tf-data-table table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
tf-data-table thead tr {
  border-bottom: 1px solid var(--border);
}
tf-data-table th {
  padding: 8px 12px;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  white-space: nowrap;
  color: var(--muted-foreground);
}
tf-data-table th[aria-sort="ascending"]::after { content: " ↑"; }
tf-data-table th[aria-sort="descending"]::after { content: " ↓"; }
tf-data-table td {
  padding: 8px 12px;
  vertical-align: top;
  white-space: nowrap;
  color: var(--foreground);
}
tf-data-table tbody tr + tr {
  border-top: 1px solid var(--border);
}
tf-data-table tbody tr:hover {
  background: var(--accent);
}
tf-data-table a {
  color: var(--primary);
  text-decoration: none;
}
tf-data-table a:hover {
  text-decoration: underline;
}
`;
