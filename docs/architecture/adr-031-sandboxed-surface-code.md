# ADR-031 — A Surface component may carry authored code, executed in an opaque-origin frame

Status: Accepted

## Context

The product promise is that a user describes what they want in Chat and an Agent builds it. For
presentation, that promise was false. `packages/surface-web/src/view.tsx` switches on
`component.name` over a fixed list of ~22 semantic components, and there are no layout or drawing
primitives — no Box, Stack, Grid or Svg. A business component authored at Chat time was resolved
server-side by `resolveSoulSurfaceView` into a tree containing only shipped component names, so an
authored component could only ever be a re-composition of what already shipped.

Observed in QA: asked for an area chart, the Agent forged `business.area-chart`, wrapped the shipped
`Chart` in `line` mode, invented a `fill` prop nothing reads, and told the user it had built an area
chart. The architecture made honesty impossible, so the model substituted and narrated.

Widening the `Chart.kind` enum per request is the loop this decision exists to leave.

## Decision

A Surface component may declare a **code view**: JSX authored by the Agent, compiled at authoring
time, and executed in the browser inside an `<iframe sandbox="allow-scripts">` — no
`allow-same-origin` — under `connect-src 'none'`.

- **Storage.** The component manifest carries a pointer, never the text:
  `code: { web: { source, module, sourceSha256 } }`, with the source and compiled module in `code/`
  companion files. `views/` stays YAML-only, so a typo'd declarative view still fails loudly instead
  of being admitted as executable content. Writes go through `SoulWriter.apply` (ADR-007) like every
  other authored write, so `git log` on the Soul shows a readable `code/web.source.jsx` diff.
- **Compile at authoring time.** `surface_component_create` runs `esbuild.transform`, so a syntax
  error is a tool error the Agent can repair inside its retry budget, not a blank frame at render.
- **Web only.** Slack and GitHub cannot execute a frame, and a parallel declarative fallback would
  drift out of sync with the code it claims to mirror. A code view declaring another channel is
  rejected at create time.
- **React runs inside the frame**, bundled and inlined by `apps/web/scripts/build-surface-sandbox.mjs`.
  Authored code gets `useState`, so local editing state costs no Agent round-trip.
- **Interactivity reuses the existing action-handle path.** `tulip.emit(action, input)` posts to the
  host, which maps it through `surfaceActionKey` to a handle minted at publish time from the
  component's declared `events`. An action with no minted handle is dropped: authored code cannot
  invent authority it was not granted.
- **Props are still validated server-side** against `propsSchema`. A sandbox is not a reason to skip
  validation.

## The boundary, stated exactly

The security boundary is **the opaque origin plus `connect-src 'none'`**. Without
`allow-same-origin` the document cannot read the host DOM, the session cookie, or storage; with no
network directive it cannot exfiltrate what it does see.

`apps/api/src/soul/surface-components/code-view.ts` refuses source text naming `fetch`, `eval`,
`localStorage`, `parent` and similar. That list is **ergonomics, not security** — `globalThis["fe" +
"tch"]` defeats it and every list like it. It exists to turn a confused Agent's mistake into a
legible tool error rather than a frame that silently does nothing. Never cite it as the reason the
frame is safe.

`apps/web/scripts/no-same-origin-sandbox.test.ts` fails the build if `allow-same-origin` appears
anywhere in the renderer, the host app, or the frame runtime.

## Relationship to ADR-016 and to the rejected in-process extension

ADR-016 keeps untrusted code out of the control-plane process; this decision does not touch it.
Authored view code never executes on a server: it runs in the reader's own browser, in a document
with no origin, no network and no credential. The rejected alternative "Dynamic in-process
third-party extensions" concerns code granted trusted memory, credentials and control-plane access —
the opposite of what a code view has.

This decision does overturn one rule in `packages/surface/AGENTS.md` — "Persisted content is
semantic data only: never HTML, CSS, JavaScript, executable templates" — for this one view kind, and
only under the pointer-plus-companion storage and the sandbox above.

## Alternatives rejected

- **A closed set of declarative drawing primitives** (Box, Stack, Svg, Path). Every new visual idea
  still needs the primitive set to have anticipated it; a spreadsheet with local edit state cannot be
  expressed at all. This is the enum-widening loop with more steps.
- **Server-side rendering of authored code.** Puts model-authored code in the control plane, which
  ADR-016 forbids.
- **`srcdoc` or a `blob:` frame.** Both inherit or complicate the host origin story; a same-origin
  static shell keeps `frame-src 'self'` sufficient and the policy identical in dev, in the single
  image, and behind an operator's proxy.

## Residual risks, accepted for v1

- **Phishing inside Chat.** A prompt-injected Agent can author a convincing fake login box. The
  sandbox stops it reaching the session or the network, so it cannot steal a credential directly —
  but it can ask the user for one and emit it as a declared action. Decided: ship without provenance
  chrome. If it becomes a real concern, the mitigation is a labelled frame rendered outside the
  iframe, which authored code cannot paint over.
- **Visual nuisance.** Height is clamped to 640px so a frame cannot fill the viewport and imitate the
  app; nothing else constrains what it draws inside that box.
