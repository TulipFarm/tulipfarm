# TSP Slack Renderer (`@tulipfarm/surface-slack`)

Produces native Slack Block Kit messages and modals from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Block Kit output, Slack modals, or the Slack renderer manifest.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Slack renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Never accept or render agent-authored markup, styles, scripts, or component code.
- Provider payloads are render outputs only and must never be persisted as canonical Artifact
  content.
