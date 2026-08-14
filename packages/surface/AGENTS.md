# Tulip Surface Protocol (`@tulipfarm/surface`)

Owns TSP contracts, semantic component catalog, Artifact validation, interaction contracts,
linting, renderer interfaces, and declarative Soul component validation.

## Read on / Skip

- **Read on if** you touch SurfaceArtifact shape, component contracts, linting, forms, renderer
  ports, or Soul component validation.
- **Skip if** you only render to one channel; use that renderer package's `AGENTS.md` instead.

## Map

| Path | Owns |
| --- | --- |
| `src/artifact.ts` | Artifact model and validation. |
| `src/catalog.ts` | Semantic component catalog. |
| `src/contracts.ts` | Renderer and interaction contracts. |
| `src/forms.ts` | Form component contracts. |
| `src/lint.ts` | Artifact linting rules. |
| `src/registry.ts` | Component registry helpers. |
| `src/schema.ts` | Shared schema helpers. |
| `src/soul.ts` | Declarative Soul component validation. |

## Rules

- Runtime-neutral only: no React, browser APIs, or provider SDK imports.
- Persisted content is semantic data only: never HTML, CSS, JavaScript, executable templates, or
  provider payloads.
