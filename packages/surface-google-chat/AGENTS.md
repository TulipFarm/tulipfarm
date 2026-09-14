# TSP Google Chat Renderer (`@tulipfarm/surface-google-chat`)

Produces Google Chat card message payloads from validated Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Google Chat message rendering or its manifest.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Google Chat renderer implementation. |
| `src/manifest.ts` | Renderer manifest metadata. |

## Rules

- Keep payloads dependency-free; no Google SDK or network calls.
- Unsupported presentation must degrade to readable text.
