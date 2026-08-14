# Soul (`@tulipfarm/soul`)
Loader, compiler, publisher, and git-sync engine for Soul artifacts. Root `soul/` is runtime data.

## Read on / Skip
- **Read on if** you change Soul loading, git sync, bundles, publication, or migrations.
- **Skip if** you change artifact schemas or layouts; start in `../schema/AGENTS.md` first.

## Map
| Path | Owns |
| --- | --- |
| `src/index.ts` | Public exports; do not mirror the list here. |
| `src/soul-loader.ts`, `src/tree-reader.ts`, `src/soul-path.ts` | Disk and tree reads. |
| `src/compiler.ts`, `src/bundle.ts`, `src/published-loader.ts` | Runtime bundles. |
| `src/signatures.ts`, `src/publication.ts`, `src/publisher.ts` | Publish flow. |
| `src/git-*`, `src/pinned-definition.ts`, `src/definition-reader.ts` | Git and pinned reads. |
| `src/integration-*`, `src/types.ts` | Integration manifest trust/auth contracts. |
| `src/migrations/`, `src/soul-migrations.ts`, `src/writer.ts` | Migrations and authoring. |

## Rules
- Do not put package code in root `soul/`; it is a separate runtime git repo.
- `SoulLoader` reads `agents/*/AGENT.md`, `skills/*/SKILL.md`, `resources/*/schema.yml`,
  `routines/*/routine.yaml`, `integrations/*/manifest.yml`, root `soul.yaml`, `guardrails.yaml`.
- Resource schemas must pass `validateResourceSchema()` on load.
- Bad files are logged and skipped; if `egress.spec` is declared but missing, that integration
  silently disappears. Writers must copy the spec beside `manifest.yml`.
- Add artifact kinds to `@tulipfarm/schema` `ARTIFACT_LAYOUTS` first; derive paths, companions,
  bundle membership, and temporal class from it. No custom regex/table.
- Pinned reads refuse `live` kinds (`Role`, `AccessGrant`) and unknown kinds; `temporalClass`
  means which digest to read, not whether the artifact is bundled.
- SOUL-V1-004: upstream wins on real divergence; preserve unpushed local commits by retrying push.
- Every successful Soul git commit helper must call the post-commit publication hook.
- Publication activates one signed digest only after committed -> projected -> stored -> active.
- API signs bundles with the private key; Workers verify with public keys only.
- Widening integration types widens third-party trust; update `integration-trust.ts` too.
- Third-party manifests reject `ts-code`, `stdio`, and non-HTTPS/non-literal `base_url`; bundled
  integrations are exempt.
- Env names: `SOUL_GIT_REMOTE_URL`, `SOUL_GIT_CREDENTIAL`; commits use bot name/email constants.
- `bootSync()` must not throw; `configureRemote()` must throw so `PUT /soul/git-config` can 400.
- Git auth is HTTPS PAT injection only; SSH remotes are unsupported.
See [building an integration](../../docs/architecture/building-an-integration.md).
