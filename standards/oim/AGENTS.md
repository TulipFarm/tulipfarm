# Open Integration Manifest (`@oim-standard/conformance`)

Vendor-neutral OIM specification, schemas, validators, vectors, CLI, and conformance protocol.

## Read on / Skip

- **Read on if** you change the portable OIM contract, distribution, CLI, or conformance suite.
- **Skip if** you only change TulipFarm runtime behavior; use the owning app/package `AGENTS.md`.

## Map

| Path | Owns |
| --- | --- |
| `SPECIFICATION.md` | Normative OIM package, profile, security, and conformance rules. |
| `schemas/`, `dist/` | Generated standalone schemas and semantic validation runtime. |
| `src/index.mjs` | Portable validation and package API. |
| `src/conformance.mjs`, `conformance/` | Behavior runner and required portable suite. |
| `src/capabilities.mjs` | Capability advertisements derived from passing reports. |
| `vectors/` | Positive, negative, and runtime behavior fixtures. |
| `bin/oim.mjs` | Standalone validation and conformance CLI. |
| `../../scripts/oim-standard-*.ts` | Repeatable generation and source-parity checks. |

## Rules

- The package entrypoint is exactly `oim.yml`; `manifest.yml` is invalid.
- `../../packages/schema/src/oim.ts` is the schema authority. Regenerate `schemas/` and `dist/`;
  never hand-maintain divergent copies.
- The distributed package stays vendor-neutral and imports no private TulipFarm runtime package.
- Conformance adapters receive inputs, never expected answers. Issue claims only from complete,
  passing behavior reports; syntax validation alone proves no runtime profile.
- Keep vectors portable and hermetic: no network, credentials, local paths, clocks, or databases.
- Publishing, repository creation, signing, and official support claims require maintainer authority.
- Verify with `pnpm --filter @oim-standard/conformance test`.
- Read [`README.md`](README.md) for usage and [`SPECIFICATION.md`](SPECIFICATION.md) for norms.
