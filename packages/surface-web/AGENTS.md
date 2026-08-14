# TSP Web Renderer (`@tulipfarm/surface-web`)

Renders validated `SurfaceArtifact` values as trusted React components for the web UI.

## Read on / Skip

- **Read on if** you touch React rendering, web manifests, or Surface CSS.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.tsx` | React renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |
| `src/styles.css` | Trusted renderer-owned styles. |

## Rules

- Never accept or render agent-authored markup, styles, scripts, or component code.
