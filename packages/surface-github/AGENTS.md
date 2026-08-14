# TSP GitHub Renderer (`@tulipfarm/surface-github`)

Produces native GitHub Markdown comments and Check Run outputs from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch GitHub comment output, Check Run output, or the GitHub manifest.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | GitHub renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Never accept or render agent-authored markup, styles, scripts, or component code.
- Provider payloads are render outputs only.
