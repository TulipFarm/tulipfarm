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
/* Any control carrying a postback payload is clickable (the runtime's delegated click handler turns
   it into a follow-up turn), so it gets the pointer affordance — overriding tf-button's display-only
   cursor:default. Attribute selector outranks the tf-button type selector. */
[data-a2ui-send] { cursor: pointer; }

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

/* tf-choices / tf-choice — present_choices options. Each tf-choice is a full-width, left-aligned
   selectable card grouping a bold label + its muted description in ONE hairline box (and one click
   target), so an option's description is never ambiguous between two buttons. The list gap separates
   options; the inner gap (2px) binds label to description. */
tf-choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
tf-choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--card);
  text-align: left;
  transition: border-color 120ms ease, background 120ms ease;
}
tf-choice:hover {
  border-color: var(--primary);
  background: var(--accent);
}
tf-choice [data-slot="label"] {
  font-weight: 600;
  color: var(--foreground);
}
tf-choice [data-slot="desc"] {
  font-size: 0.875rem;
  color: var(--muted-foreground);
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

/* tf-schema-form + form inputs — DISPLAY-ONLY skins over native controls (no iframe JS until
   A2UI-V1-001; CSP blocks submit). Contract: <tf-schema-form> holds [data-slot="field"] rows, each a
   caption (data-slot="label", with data-slot="req" for the * marker) + a native control wrapped in
   its tf-* skin + optional data-slot="error". Field identity rides data-name, never name/id (DOMPurify
   SANITIZE_DOM strips colliding name/id). x-immutable on edit = native disabled + a data-slot="meta"
   "(immutable)" note. */
tf-schema-form { display: block; }
tf-schema-form [data-slot="field"] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
tf-schema-form [data-slot="label"] { font-size: 0.75rem; color: var(--muted-foreground); }
tf-schema-form [data-slot="req"] { color: var(--primary); }
tf-schema-form [data-slot="meta"] { opacity: 0.6; }
tf-schema-form [data-slot="error"] { font-size: 0.75rem; color: var(--destructive); }

/* shared control base — tf-input/textarea/select/combobox/calendar each wrap a full-width native control */
tf-input,
tf-textarea,
tf-select,
tf-combobox,
tf-calendar { display: block; }
tf-input input,
tf-textarea textarea,
tf-select select,
tf-combobox input,
tf-calendar input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 2px;
  font: inherit;
  font-size: 0.875rem;
  background: var(--background);
  color: var(--foreground);
}
tf-input input:focus-visible,
tf-textarea textarea:focus-visible,
tf-select select:focus-visible,
tf-combobox input:focus-visible,
tf-calendar input:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
tf-input input:disabled,
tf-textarea textarea:disabled,
tf-select select:disabled,
tf-combobox input:disabled,
tf-calendar input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
tf-textarea textarea { min-height: 5rem; resize: vertical; }

/* checkbox + radio-group — native accent, inline label carrying the option text */
tf-checkbox,
tf-switch { display: inline-flex; align-items: center; }
tf-radio-group { display: flex; flex-direction: column; gap: 6px; }
tf-checkbox label,
tf-switch label,
tf-radio-group label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: var(--foreground);
}
tf-checkbox input[type="checkbox"],
tf-radio-group input[type="radio"] {
  width: 1rem;
  height: 1rem;
  margin: 0;
  accent-color: var(--primary);
}

/* switch — CSS-only toggle built from a native checkbox (flat 2px radius; off=secondary, on=primary) */
tf-switch input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 36px;
  height: 20px;
  margin: 0;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--secondary);
  cursor: pointer;
  transition: background 120ms ease;
}
tf-switch input[type="checkbox"]::after {
  content: "";
  position: absolute;
  top: 1px;
  left: 1px;
  width: 16px;
  height: 16px;
  background: var(--background);
  border-radius: 1px;
  transition: left 120ms ease;
}
tf-switch input[type="checkbox"]:checked { background: var(--primary); }
tf-switch input[type="checkbox"]:checked::after { left: 17px; }
tf-switch input[type="checkbox"]:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

/* combobox — search input + a static options listbox (skinned like tf-list) + a ▾ affordance */
tf-combobox { position: relative; }
tf-combobox input { padding-right: 28px; }
tf-combobox::after {
  content: "▾";
  position: absolute;
  top: 10px;
  right: 10px;
  color: var(--muted-foreground);
  pointer-events: none;
}
tf-combobox ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  border: 1px solid var(--border);
  background: var(--background);
  font-size: 0.875rem;
}
tf-combobox li { padding: 6px 12px; color: var(--foreground); }
tf-combobox li + li { border-top: 1px solid var(--border); }
tf-combobox li:hover,
tf-combobox li[aria-selected="true"] { background: var(--accent); color: var(--accent-foreground); }

/* tf-chart-bar / tf-chart-line — fixed-height box for the Chart.js canvas. The fixed height lets
   maintainAspectRatio:false fill a stable box, so the canvas cannot grow into the runtime's
   ResizeObserver height report (no feedback loop). Series/axis colors are set by the chart bootstrap
   from CSS tokens (palette-honest, no green/amber). */
tf-chart-bar,
tf-chart-line {
  display: block;
  position: relative;
  height: 320px;
  margin: 12px 0;
}
tf-chart-bar > canvas,
tf-chart-line > canvas { display: block; }
`;
