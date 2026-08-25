# Soul (`@tulipfarm/soul`)
Loader, compiler, publisher, and git-sync engine for Soul artifacts. Root `soul/` is runtime data.

## Read on / Skip
- **Read on if** you change Soul loading, git sync, bundles, publication, or migrations.
- **Skip if** you change artifact schemas or layouts; start in `../schema/AGENTS.md` first.

## Map
| Path | Owns |
| --- | --- |
| `src/index.ts` | Public exports; do not mirror the list here. |
| `src/repo-dir.ts` | Locates the checkout for the dev-only bundled Skill/integration fallbacks. |
| `src/soul-loader.ts`, `src/tree-reader.ts`, `src/soul-path.ts` | Disk and tree reads. |
| `src/compiler.ts`, `src/bundle.ts`, `src/bundle-retention.ts`, `src/published-loader.ts` | Runtime bundles. |
| `src/signatures.ts`, `src/publication.ts`, `src/publisher.ts` | Publish flow. |
| `src/routine-catalog.ts`, `src/routines/` | Routines browse model; Routine reference validation. |
| `src/git-*`, `src/pinned-definition.ts`, `src/definition-reader.ts` | Git and pinned reads. |
| `src/integration-*`, `src/types.ts` | Integration manifest trust/auth contracts. |
| `src/migrations/`, `src/soul-migrations.ts` | Migrations. |
| `src/writer.ts` | `SoulWriter` — the one authored-tree write gateway. |
| `src/skills/`, `src/integrations/`, `src/agents/` | Skill threat scan, bundled discovery and reference reads, registries, platform agents. |
| `src/{catalogue,tree,git-source,write-errors}.ts` | Catalogue, safe tree walk, Git source parsing, write-error mapping. |
| `src/soul-writer-double.ts` | In-memory `SoulWriter` for tests. |

## Rules
- Do not put package code in root `soul/`; it is a separate runtime git repo.
- `skills/bundled.ts` and `integrations/bundled.ts` locate the repo-root `skills/` and
  `integrations/` directories by counting `__dirname` levels. Moving either file changes that
  depth; the fallback chain hides a wrong path in production, so re-check it on any move.
- `skills/lock.ts` owns `skills-lock.json`: the `SkillSourceType` vocabulary
  (`bundled` | `marketplace` | `public` | `curated`) and per-entry Skill versions. Never hand-roll a
  lock shape. Entries predating the vocabulary recorded git URL *shape* (`"github"`/`"git"`) and are
  reclassified on read.
- **Mutate the lock only through `skills/lock-write.ts`, never a bare `soulWriter.apply`.** It is a
  whole-file read-modify-write, so two writers on one revision each commit a lock missing the
  other's entry, erasing a Skill's provenance. `mutateSkillsLock` queues per Soul *and* commits
  against the revision it read. A path that cannot use the gateway — `skill_update` materializing a
  bundled Skill — still joins the queue via `serializeSkillsLockWrites`.
- `skills/sync-bundled.ts` seeds every shipped Skill into `soul/skills/<name>/` at API boot and
  claims it in the lock as `bundled`. It rewrites a copy only while that copy still hashes to the
  locked value, so an operator or Agent edit permanently opts the Skill out of image updates. The
  same pass reaps retired Skills, persists the normalized vocabulary, and records anything else on
  disk as `curated`, so the lock is a complete inventory. Copy `SKILL.md` verbatim apart from the
  forge-contract expansion: converting to `skill.yaml` would silently drop `tools`/`category`,
  which `SkillSpec` cannot carry.
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
  digest only after committed -> projected -> stored -> active. `SoulPublisher.publishCommittedTree`
  settles its own publication inline, so `SoulWriteResult.published` means active, not enqueued.
- API signs bundles with the private key; Workers verify with public keys only. SOUL-V1-004:
  upstream wins on real divergence; preserve unpushed local commits by retrying push.
- Widening integration types widens third-party trust; update `integration-trust.ts` too. Third-party
  manifests reject `ts-code`, `stdio` and non-HTTPS/non-literal `base_url`; bundled ones are exempt.
- Env names: `SOUL_GIT_REMOTE_URL`, `SOUL_GIT_CREDENTIAL`; commits use bot name/email constants.
  Auth is HTTPS PAT injection only; SSH remotes are unsupported.
- `bootSync()` must not throw; `configureRemote()` must throw so `PUT /soul/git-config` can 400.
See [building an integration](../../docs/architecture/building-an-integration.md).
