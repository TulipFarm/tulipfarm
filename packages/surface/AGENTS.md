# Tulip Surface Protocol (`@tulipfarm/surface`)

Owns TSP contracts, semantic component catalog, Artifact validation, interaction contracts,
renderer interfaces, and declarative Soul component validation.

## Read on / Skip

- **Read on if** you touch SurfaceArtifact shape, component contracts, forms, renderer
  ports, or Soul component validation.
- **Skip if** you only render to one channel; use that renderer package's `AGENTS.md` instead.

## Map

| Path | Owns |
| --- | --- |
| `src/artifact.ts` | Artifact model and validation. |
| `src/catalog.ts` | Semantic component catalog. |
| `src/catalog-data-display.ts` | Data-display component family (Metric, Timeline, Comparison, Breakdown, Gauge, Chart, ForceGraph). |
| `src/action-constraints.ts` | Action key/pattern limits both the schema and the browser read. |
| `src/client.ts` | Browser-safe action helpers and type-only Surface contracts. |
| `src/contracts.ts` | Renderer and interaction contracts. |
| `src/forms.ts` | Form component contracts. |
| `src/registry.ts` | Component registry helpers. |
| `src/schema.ts` | Shared schema helpers. |
| `src/soul.ts` | Declarative Soul component validation; Code-view gates and presentation resolution. |
| `src/sandbox.ts` | The host-to-frame contract for Code views: path, `sandbox` grant, CSP, messages. |

## Rules

- Runtime-neutral only: no React, browser APIs, or provider SDK imports.
- Persisted content is semantic data only: never HTML, CSS, JavaScript, executable templates, or
  provider payloads. The single exception is a **Code view** — Agent-authored JSX a component may
  carry under `code:`, compiled at authoring time and executed only in the opaque-origin sandbox
  frame (`src/sandbox.ts`, ADR-031). It never composes into another component and never resolves
  into a view tree.
