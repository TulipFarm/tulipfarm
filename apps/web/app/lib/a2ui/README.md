# A2UI — security / rendering foundation

The boundary that renders **untrusted, agent-emitted HTML** (from the `compose_view` tool)
safely. Built per `specs/A2UI.md` A2UI-V1-004; design: `docs/plans/2026-06-09-a2ui-foundation-design.md`.

```
html → sanitizeAgentHtml (DOMPurify) → buildSrcdoc (CSP + tokens + runtime) →
  <iframe sandbox="allow-scripts">  (no same-origin ⇒ opaque origin, can't reach parent DOM)
  ↕ postMessage bridge (the ONLY channel across the boundary)
```

## Modules
- **`protocol.ts`** — message envelope + `parseMessage()` structural gate (frame ⇄ host).
- **`sanitize.ts`** — DOMPurify: strips `<script>`/`on*`/`javascript:`/`style=`; allows `tf-*` + `data-`/`aria-`.
- **`srcdoc.ts`** — assembles the iframe document: strict CSP (`default-src 'none'`, nonce'd script,
  no external network), injected design tokens (`~/tokens.css?raw`), reset, runtime, sanitized body.
- **`runtime.ts`** — audited **string** injected into the frame: `window.__a2ui.send(channel, payload)`
  for future `tf-*` components, rAF-batched resize, `ready`, and re-dispatch of host messages as
  `document` `CustomEvent("a2ui:message")`.
- **`chart-source.ts`** — GENERATED (`scripts/gen-chart-source.mjs`, committed): the Chart.js UMD as a
  string const. Inlined as a nonce'd `<script>` because the CSP forbids a CDN. Re-run
  `pnpm gen:chart-source` on a chart.js bump.
- **`chart-bootstrap.ts`** — audited **string** (injected after Chart.js, only when the body contains a
  `tf-chart-` element): scans `tf-chart-bar`/`tf-chart-line`, parses `data-labels`/`data-datasets`,
  draws into a canvas it creates, colors from CSS tokens. One bad chart is isolated in try/catch.
- **`../../components/a2ui-frame.tsx`** — `<A2uiFrame>` React component: the sandboxed iframe + the
  parent bridge. **Pure transport** — relays to `onAgent`/`onApi`/`onNavigate`; never calls the API
  or navigates. `ref.send(msg)` pushes a message into the frame.

## Security invariants (do not break — each has a test)
1. `sandbox="allow-scripts"` **only** — never `allow-same-origin` (the combo is a sandbox escape).
2. CSP blocks all external network; scripts limited to a fresh `crypto.randomUUID()` nonce per render.
3. Agent HTML is sanitized (defense-in-depth behind sandbox + CSP).
4. Parent accepts a message only when `event.source === iframe.contentWindow` **and** `event.origin === "null"`.
5. The runtime is a self-contained string with no value-imports (survives minification).

## Usage
```tsx
const ref = useRef<A2uiFrameHandle>(null);
<A2uiFrame ref={ref} html={agentHtml} onApi={(p) => /* host decides */} />
// ref.current?.send({ channel: "api", payload: result });  // host → frame
```
`/dev/a2ui` (DEV only) is the live harness used for Playwright validation.

## Not here (separate tickets)
`tf-*` web components (A2UI-V1-002) · chat message renderer + SSE wiring + mounting into the real
chat route (A2UI-V1-001).
