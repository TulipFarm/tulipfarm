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
| `src/compiler.ts`, `src/bundle.ts`, `src/bundle-retention.ts`, `src/published-loader.ts` | Runtime bundles. |
| `src/signatures.ts`, `src/publication.ts`, `src/publisher.ts` | Publish flow. |
| `src/git-*`, `src/pinned-definition.ts`, `src/definition-reader.ts` | Git and pinned reads. |
| `src/integration-*`, `src/types.ts` | Integration manifest trust/auth contracts. |
| `src/migrations/`, `src/soul-migrations.ts` | Migrations. |
| `src/writer.ts` | `SoulWriter` — the one authored-tree write gateway. |
| `src/skills/`, `src/integrations/`, `src/agents/` | Skill threat scan, bundled discovery, registries, platform agents. |
| `src/{catalogue,tree,git-source,write-errors}.ts` | Catalogue, safe tree walk, Git source allowlist, write-error mapping. |
| `src/soul-writer-double.ts` | In-memory `SoulWriter` for tests. |

## Rules
- Do not put package code in root `soul/`; it is a separate runtime git repo.
- `skills/bundled.ts` and `integrations/bundled.ts` locate the repo-root `skills/` and
  `integrations/` directories by counting `__dirname` levels. Moving either file changes that
  depth; the fallback chain hides a wrong path in production, so re-check it on any move.
- `SoulLoader` reads `agents/*/AGENT.md`, `skills/*/SKILL.md`, `resources/*/schema.yml`,
  `routines/*/routine.yaml`, `integrations/*/manifest.yml`, root `soul.yaml`, `guardrails.yaml`;
  resource schemas must pass `validateResourceSchema()` on load.
- Bad files are logged and skipped; a declared-but-missing `egress.spec` silently drops that
  integration, so writers must copy the spec beside `manifest.yml`.
- Add artifact kinds to `@tulipfarm/schema` `ARTIFACT_LAYOUTS` first and derive paths, companions,
  bundle membership and temporal class from it — no custom regex/table.
- Pinned reads refuse `live` kinds (`Role`, `AccessGrant`) and unknown kinds; `temporalClass` means
  which digest to read, not whether the artifact is bundled.
- `SoulWriter.apply()` is the only authored-tree write path: validate, commit atomically, publish,
  push, reload. Add no other commit helper.
- `GitSyncService` stages only the paths given (`commitPaths`/`withSyncPaths`); there is no ambient
  `commit`/`withSync`, and `git add -A` is confined to scaffolding an empty repo.
- Every commit helper must call the post-commit publication hook; publication activates one signed
  digest only after committed -> projected -> stored -> active.
- API signs bundles with the private key; Workers verify with public keys only. SOUL-V1-004:
  upstream wins on real divergence; preserve unpushed local commits by retrying push.
- Widening integration types widens third-party trust; update `integration-trust.ts` too. Third-party
  manifests reject `ts-code`, `stdio` and non-HTTPS/non-literal `base_url`; bundled ones are exempt.
- Env names: `SOUL_GIT_REMOTE_URL`, `SOUL_GIT_CREDENTIAL`; commits use bot name/email constants.
  Auth is HTTPS PAT injection only; SSH remotes are unsupported.
- `bootSync()` must not throw; `configureRemote()` must throw so `PUT /soul/git-config` can 400.
See [building an integration](../../docs/architecture/building-an-integration.md).
