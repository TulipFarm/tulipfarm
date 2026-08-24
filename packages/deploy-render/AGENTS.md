# Deploy render (`@tulipfarm/deploy-render`)

The single rendering seam for deployment guidance: `deploy/contract.yml` plus the target manifests
in `deploy/targets/*` go in, every rendered surface comes out.

## Read on / Skip

- **Read on if** you change what a deployment surface says, add a target, or add a surface
  (documentation page, single-file prompt, guided-flow model, referenced artifact).
- **Skip if** you only change what the runtime *needs* — that is `deploy/contract.yml` and its
  schema in `packages/schema`. Skip also if you only persist output; that is the caller's job.

## Map

| Path | Owns |
| --- | --- |
| `src/render.ts` | `renderDeploymentSurfaces` — the seam, and every surface it emits. |
| `src/index.ts` | Public exports; do not mirror the list here. |

## Rules

- **The renderer is pure.** No filesystem access, no network, no clock, no environment read. It
  takes manifest *strings* and returns *strings*. Every caller — the docs generator, the prompt,
  the guided flow — drives the same call, so a surface that renders differently per caller is a
  bug. The thin script that persists output lives in `apps/docs/scripts/`.
- Parse only through `parseDeploymentContract` / `parseDeploymentTarget` from `@tulipfarm/schema`.
  Re-parsing the YAML here would let a manifest that fails validation reach a rendered page.
- **Never generate a published artifact.** `docker-compose.yml` and the example environment file
  are hand-maintained, served byte-identical from the site, fetched by `install.sh`, and
  parity-tested in CI. A target *references* them; it does not emit them.
- Every step must carry a verification, and the kinds are a closed set. Both are enforced in the
  schema — do not add a rendering-time escape hatch.
- Generated pages carry a header naming their source manifest. A staleness test regenerates in
  memory and compares byte-for-byte, so hand-editing a generated page fails CI rather than
  silently drifting.

See [`docs/architecture/deployment-manifest.md`](../../docs/architecture/deployment-manifest.md)
for the design and the decisions behind it.
