# TulipFarm Terminology — Canonical Glossary

**Status:** binding. This is the single source of truth for what every concept is
called, at every layer (code, DB, REST, URL, UI, docs). Linked from AGENTS.md —
all agents and contributors MUST follow it. The cross-layer renames it prescribes have
been applied across the repo (see *Completed Renames*); where any new divergence appears,
the canonical term wins.

## How to read this

Every concept has ONE canonical term. The layer columns show how that term is
spelled per layer; they are spellings of the SAME concept, never different concepts.

| Layer | Convention |
|---|---|
| **Code (types)** | `PascalCase` (`Conversation`, `Record`) |
| **Code (vars/fns)** | `camelCase` |
| **Files** | `kebab-case` |
| **DB table/collection** | lowercase, plural |
| **REST path** | `/api/v1/<plural-kebab>` |
| **App URL** | `/<kebab>` |
| **UI label** | Title Case |

## Cross-cutting rule: external vs internal vocabulary

Two concepts deliberately use two words across a clean boundary — this is a rule,
not drift:

- **Chat** = the *external/wire* word: app routes, REST paths, UI labels, the verb.
- **Conversation** = the *internal/persistence* word: entity, table, repo, domain code.

Never let these bleed: UI/URL never say "conversation"; domain/DB never say "chat".

## Canonical glossary

| Concept (what it is) | Canonical | Code | REST / URL | UI label | Notes & retired synonyms |
|---|---|---|---|---|---|
| Product surface for messaging an agent | **Chat** | — | `/chat`, `/chat/:id`, `/api/v1/chats` | "Chat", "New chat" | external/wire word only |
| A persistent message thread (the entity) | **Conversation** | `Conversation` | (stored under chat paths) | — | internal word; table/repo/domain |
| One user→assistant exchange | **Turn** | `Turn` | — | — | child of Conversation |
| Atomic message unit | **Message** | `Message` | — | — | roles: system\|user\|**assistant**\|tool |
| Auth/login session (cookie) | **Session** | `Session` | `/api/v1/auth/...` | — | AUTH ONLY — never the chat thread |
| Configured AI persona/worker | **Agent** | `Agent` | `/agents`, `/api/v1/agents` | "Agents" | normal chat is the default harness; Agents are user-created |
| The resource feature | **Resources** | — | `/resources` | "Resources" | umbrella |
| A user-defined schema (Ticket, Customer) | **Resource type** | `ResourceType` | `/resources/:type` | "Resource type" | has a JSON **schema** |
| The JSON Schema artifact of a type | **Schema** | `schema` | `/resources/:type/schema` | "Schema" | |
| A single data instance | **Record** | `Record` | `/resources/:type/:id` | "Record" | ⛔ bare "resource" for an instance is BANNED |
| A scheduled/triggered automation | **Routine** | `Routine` | `/routines`, `/api/v1/routines` | "Routines" | `workflow` = only the CNCF spec-format ref |
| One execution of a routine | **Run** | `Run` | `/routines/:id/runs/:runId` | "Run" | `execution` → retired |
| A durable, ordered fact a Run emitted while executing | **Run event** | `RunEvent` | `/api/v1/runs/:id/events` | — | DB: run_events; types are the closed vocabulary in `@tulipfarm/schema`; ⛔ `SSE event`/`stream frame` name the transport, not the fact |
| Who a Run event may be shown to | **Audience** | `RunEventAudience` | — | — | `participant` (in the conversation) \| `operator` (evidence: digests, dispatch records) |
| How a routine starts | **Trigger** | `Trigger` | — | "Trigger" | event·manual·cron·webhook·agent |
| A step in a routine | **State** | `State` | — | "State" | CNCF Serverless Workflow term |
| A connected third-party | **Integration** | `Integration` | `/integrations`, `/api/v1/integrations` | "Integrations" | `connection`/`connector` → retired |
| The data file that fully defines an Integration | **Integration manifest** | `IntegrationManifest` | — | — | `integrations/<slug>/manifest.yml`; identity + `auth` + `egress` (+ optional `ingress`). Authoring reference: `docs/architecture/building-an-integration.md`; ⛔ "integration config"/"connector definition" |
| What an Integration lets agents *do* to the provider | **Egress** | `EgressConfig` | — | — | `openapi` \| `mcp` \| `ts-code` \| `none`; ⛔ "outbound"/"actions" as the block's name |
| One provider API operation published as an agent Tool | **Egress operation** | `EgressOperation` | — | — | an explicit allowlist entry under `egress.operations`; compiles to a `ToolContractSpec`; ⛔ publishing a whole spec |
| What an Integration lets the provider *send* TulipFarm | **Ingress** | `IngressConfig` | — | — | webhooks and event normalization; ⛔ "inbound"/"listener" as the block's name |
| The GitHub App a deployment registered for itself | **GitHub App** | — | — | "GitHub App" | one App per *deployment*, created by that deployment via GitHub's App Manifest flow and owned by whoever runs it; ⛔ "the TulipFarm GitHub App" — there is no vendor-owned App every customer installs |
| A customer's install of the GitHub App into their org/repos | **GitHub App installation** | maps to an `Integration` row (`external_tenant_id` = GitHub `installation_id`) | `/api/v1/integrations/github/installations/:id` | "GitHub Install" | one per customer connect; ⛔ "GitHub connection"/"GitHub OAuth" — this is App-install, not OAuth |
| Short-lived (~1hr) bearer credential minted per installation | **Installation access token** | — | — | — | minted via App JWT exchange, refreshed before expiry; never persisted long-term, never logged |
| An installation's account + selected repos + granted permissions | **Installation scope** | `GitHubInstallationScope` | — | — | `packages/integrations/src/github/scope.ts` |
| Which repos an installation/access grant covers | **Repository grant** | `AccessGrant` (`externalTargets: {type: "github.repository", ids[]}`) | — | "Connected repositories" | maps onto `integration_access_grants` |
| A channel sender bound to a TulipFarm account | **Channel link** | `ChannelLink` | `/api/v1/identity/channel-links/*`, `/link-channel` | "Link channel" | stored in external_identity_mappings, provider = integration slug; ⛔ "channel identity" as the *link* — that names the sender side only |
| A Confluence-side user identity used for Knowledge ACLs | **Confluence account** | `ConfluenceAccount` | — | "Confluence account" | Atlassian `accountId`; maps explicitly through `external_identity_mappings` with provider `confluence`; unmapped accounts grant no Knowledge access |
| A Notion-side user identity used for Knowledge ACLs | **Notion user** | `NotionUser` | — | "Notion user" | Notion user id or email from a verifiable reader property; maps through `external_identity_mappings` with provider `notion`; unmapped users grant no Knowledge access |
| A Google permission subject used for Drive/Docs Knowledge ACLs | **Google permission subject** | `GooglePermissionSubject` | — | "Google permission subject" | User email, group email, or explicitly mapped domain from Drive permissions; link-sharing (`anyone`) grants no Knowledge access |
| The single-use invitation that creates one | **Bind link** | `ChannelBind*` | — | "Link your account" | HMAC-signed, 15 min, nonce consumed on redemption; a credential — never logged, never in a query string |
| The single-use link that gives a TulipFarm account its password | **Invite link** | `Invite`, `UserInvite*` | `/api/v1/users/:id/invite`, `/api/v1/auth/invites/*`, `/accept-invite` | "Invite link", "Reset password link" | Random secret, hash-only storage, 7 days, consumed on redemption; re-issuing revokes the outstanding one and is also the password recovery path. ⛔ "temporary password" — none is ever minted. Distinct from a **Bind link**, which links a channel sender, not an account |
| Auth material for a provider/integration | **Credential** | `Credential` | — | "Credentials" | API key/token/login; *backed by* a Secret |
| Encrypted at-rest value (storage primitive) | **Secret** | `Secret` | `/business/secrets` | "Secrets" | the store; ≠ Credential |
| Boot-time value from `.env`/`process.env` | **Env Config** | — | — | — | restart-required; not all values are secret (e.g. `SOUL_PATH`) — the one genuinely secret value inside it is the KEK (`ENCRYPTION_KEY`), named directly, not by renaming this bucket |
| An installable agent capability module | **Skill** | `Skill` | `/skills`, `/api/v1/skills` | "Skills" | `plugin`/`capability` → retired as synonyms¹ |
| Where skills are browsed/installed | **Marketplace** / **Install** | — | `/skills/marketplace`, `/skills/install` | "Marketplace" | |
| The git-backed config repo | **Soul** | `Soul` | `/api/v1/soul` | "Soul" | holds agents/routines/skills/integrations/resources |
| Git-tracked YAML settings inside the Soul repo | **Soul Config** | `SoulConfig` | — | — | e.g. `soul.yaml`, `guardrails.yaml`; non-secret, runtime-editable but reload behavior varies (some apply on `soul.synced`, others require restart) |
| The knowledge wiki feature | **Knowledge** | — | `/knowledge` | "Knowledge" | a wiki |
| A grouping of pages | **Space** | `Space` | `/knowledge/spaces/:id` | "Space" | retires `bundle`, `collection`²; DB: knowledge_spaces, knowledge_space_overrides |
| A knowledge content node | **Page** | `Page` | `/knowledge/pages/:id` | "Page" | retires `concept`, `document`; pages link pages (backlink graph); DB: knowledge_pages |
| A runtime human-decision gate | **Approval** | `Approval` | `/approvals`, `/api/v1/approvals` | "Approvals" | not "review"/"request" |
| A policy constraining agent/tool behavior | **Guardrail** | `Guardrail` | `/api/v1/guardrails` | "Guardrails" | `policy`/`rule` are subordinate parts, not the concept |
| A callable function exposed to agents | **Tool** | `Tool` | — | "Tool" | includes MCP tools |
| Durable recalled facts across chats | **Memory** | `Memory` | `/api/v1/memory` | "Memory" | ≠ Context |
| The owner boundary that decides who can use Memory | **Memory Scope** | `MemoryScopeTarget` | — | — | scopes are `user_private`, `user_agent`, `agent_private`, `team_role`, `business`, `run`; authorization is identity-to-owner, not broad capability |
| The category of an Assertion | **Memory Type** | `MemoryType` | — | — | `preference`, `fact`, `procedural`, `episodic`; drives recall/rendering semantics; ⛔ "kind" |
| One durable, scoped, versioned Memory statement | **Assertion** | `MemoryAssertion` | `/api/v1/memory/assertions/:id` | "Memory" (not surfaced as its own noun) | the unit Memory is made of; carries scope owner, provenance, evidence, confidence, validity interval; ⛔ "memory entry", "memory item", "fact row" |
| The source reference supporting an Assertion | **Memory Evidence** | `MemoryEvidenceRef` | — | — | message, Knowledge source, or Tool result reference; Knowledge source evidence is reauthorized on every recall; ⛔ "citation" when it gates recall |
| The time interval during which an Assertion was true | **Validity Interval** | `validFrom` / `validTo` | — | — | half-open valid time used by Point-in-time Recall; separate from transaction time (`createdAt` / `recordedUntil`) |
| A durable summary of what happened, what was decided, and the outcome | **Episode** | `MemoryEpisode` | — | "History" | derived from a Conversation or a Run; indexed via `memory_chunks`; recallable across chats; ⛔ "event" (that is a Run event), "summary" (that is compaction output) |
| An inferred Assertion awaiting its scope owner's confirmation | **Pending Memory** | `PendingMemory` | `/api/v1/memory/pending/:id` | "Suggested memories" | lives outside the Assertion store; deny/expiry deletes it and persists nothing; ⛔ "draft memory", "candidate" in user-facing copy |
| How much an Assertion's origin is trusted | **Trust Tier** | `MemoryTrustTier` | — | — | `user_stated` > `agent_inferred` > `external_derived`; drives whether confirmation is required; ⛔ "trust level", "source rank" |
| An explicit human correction saved as behavior-shaping Memory | **Procedural Correction** | `rememberProceduralCorrection` | `/api/v1/memory/corrections` | "Correction" | creates a `procedural` Assertion with `user_stated` Trust Tier; never produced by Memory Extraction; ⛔ "learned instruction" |
| Soft-removing an Assertion while keeping lineage | **Forget** | `forgetMemory` | `/api/v1/memory/assertions/:id/forget` | "Forget" | sets `status = forgotten` and clears statement text; row remains for audit; ⛔ "delete" when a tombstone remains |
| Hard-purging an Assertion and derived Memory copies | **Erase** | `eraseMemory` | `/api/v1/memory/assertions/:id` | "Erase" | removes Assertion, evidence, Pending Memory references, recall rows, Episodes, and chunks; audit keeps counts only; ⛔ "forget" |
| The always-on Memory rendered into every turn's Context | **Core Block** | `MemoryCoreBlock` | — | — | the pinned tier; the rest of Memory reaches the model by retrieval; ⛔ "working memory" (retired), "pinned memory" |
| Memory retrieved by relevance to the current turn, alongside the Core Block | **Recalled Memory** | `RecalledMemory` | — | — | rendered as `<recalled-memory>`; per-turn and speculative, so it is context and never a standing instruction; ⛔ "retrieved memory", "relevant memory" |
| Mining a finished Turn for durable facts | **Memory Extraction** | `MemoryExtractionService` | — | — | runs after the Turn answers, never inside it; only ever produces Pending Memory; ⛔ "memory learning", "auto-save" |
| One inferred statement before it is screened and parked | **Memory Candidate** | `MemoryCandidate` | — | — | internal to extraction; becomes a Pending Memory only if it passes screening; ⛔ "suggestion" in code |
| Closing a stored Assertion's validity because a newer one replaced it | **Contradiction** | `MemoryContradictionPort` | — | — | closes `valid_to`, never deletes; scoped, trust-ranked, and offered-ids-only; ⛔ "overwrite", "conflict resolution" |
| Asking what was true at a past moment | **Point-in-time Recall** | `validAt` | — | — | includes superseded Assertions whose valid interval covers the moment; ⛔ "time travel", "history query" |
| Assembled model-input window for a turn | **Context** | `Context` | — | — | the Context Engine (assembly, compaction); ≠ Memory |
| First-run setup wizard | **Onboarding** | `Onboarding` | `/onboarding` | "Onboarding" | |
| Model Context Protocol (external tool servers) | **MCP** | `MCP` | — | "MCP" | acronym, verbatim |
| A governed model routing record derived from Soul Config | **ModelProfile** | `ModelProfile` | `/api/v1/model-profiles` | "Model profile" | one word, `PascalCase` — synthesized deterministically from `soul.yaml#llm` and pinned into immutable bundles; holds provider/model, capability, modality, constraints, budgets, fallbacks. There is no authored `models/` directory. ⛔ "tier" as the routing unit — retired |
| A named effort level a participant may pick | **Effort Preset** | `EffortPreset` | — | "Auto"/"Fast"/"Balanced"/"Thorough" | the ONLY model concept a user sees; maps to a ModelProfile ref, one marked default. ⛔ "quick"/"standard"/"complex" — retired |
| Credentials + endpoint for one provider | **Provider Connection** | `ProviderConnection` | — | "Provider" | `provider → {api_key_ref, base_url, resource_name}`; secret-bearing, admin-managed. Distinct from a ModelProfile, which is governance and git-audited |
| A Provider Connection backed by a personal CLI subscription token instead of an API key | **Subscription Provider** | `CliLanguageModel` (`packages/llm/src/cli/`) | — | "(subscription)" suffix on the provider label | `claude-code` (`@anthropic-ai/claude-agent-sdk`) and `codex` (`@openai/codex`); runs a coding-agent CLI as the model in a jailed subprocess, one call per AgentLoop iteration, tool calls captured and never executed by the CLI. Turns are reported **unpriced** — a subscription turn has no per-token cost. See `docs/plans/cli-agent-providers.md`. ⛔ "harness" — already means the default chat surface (see Agent row above) |
| The raw provider model identifier | **Model ID** | `modelId` | — | — | e.g. `claude-sonnet-4`; an implementation detail of a ModelProfile — never a user-facing choice, never a routing unit |
| What a completed reply reports about the call that produced it | **Receipt** | `ModelCallReceipt` | — | "Answered by …" | participant-visible: Model ID, effort asked, effort applied, model-call latency. ⛔ cost — operator-only, on the `model.routed` Run event |
| Re-running a turn one effort level higher | **Try harder** | `nextEffortPreset` | — | "Try harder" | always the participant's choice; escalates from the effort the receipt says was *applied*. ⛔ "retry"/"regenerate" — those repeat a turn unchanged |
| Agent-to-channel presentation standard | **Tulip Surface Protocol** | `TSP`, `SurfaceArtifact`, `SurfaceRenderer`, `SurfaceInteraction` | `/api/v1/surfaces`, `/dev/surfaces`, `surface-components/` | "Tulip Surface Protocol", "presentation" | Channel-neutral semantic components; never persisted provider payloads or executable UI |

¹ `plugin` remains valid ONLY for build/library tooling (vite, rehype, Chart.js) — never for a Skill.
² `collection` is reserved exclusively for "a Postgres/MongoDB collection" (infra). It never means a knowledge grouping.

## Banned / retired terms (quick lookup)

| Don't write | Write instead | Status |
|---|---|---|
| conversation (in UI/URL/REST) | chat | clean |
| chat (in entity/DB/domain) | conversation | clean |
| resource (meaning one instance) | record | clean (see Completed Renames) |
| workflow (meaning a routine) | routine | clean (only CNCF/CI uses remain) |
| execution (of a routine) | run | clean (only tool-execution uses remain) |
| connection / connector | integration | clean (only DB/SSE uses remain) |
| plugin (meaning a skill) | skill | clean (only build-tool uses remain) |
| capability (meaning a skill) | skill | clean |
| bundle | space | clean (only build-bundle uses remain) |
| collection (meaning a knowledge group) | space | retired (see Completed Renames) |
| concept (knowledge node) | page | clean |
| document (knowledge node) | page | clean |
| tier (meaning model routing) | ModelProfile | retiring — accepted as a deprecated wire alias for one release |
| quick / standard / complex | Effort Preset (Auto/Fast/Balanced/Thorough) | retiring — deprecated wire aliases for one release |
| model (meaning the user-facing choice) | effort preset | clean — a user picks effort, never a model |
| LLM page | Models | clean |
| Users page / Roles page | People | clean |
| Security page | Auth | clean |
| working memory | Core Block (the pinned tier) or Assertion (one stored fact) | code clean — every `WorkingMemory*` identifier retired (`MemoryService`, `MemoryAssertionView`, `MemoryRepo`, `EngineMemoryRepo`); the legacy `working_memory` **table** intentionally survives one more release as the cutover's recovery path (see `memory/backfill.pg.test.ts`), then drops |
| memory entry / memory item | assertion | code clean — `InvalidMemoryAssertionError`, `assertValidAssertion`; `MAX_ENTRIES`/`MAX_TOTAL_CHARS` keep their names as cap constants, not as a term for an Assertion |

## Completed Renames (done 2026-06-27)

The cross-layer mismatches this doc prescribed have been applied across code, DB, REST,
URL, UI, and docs. Migration `v18` renamed the physical Knowledge tables/columns/indexes.

1. **Knowledge → Space/Page** (largest): `bundle`→`space`, `concept`/`document`→`page`
   across DB (tables `knowledge_spaces`/`knowledge_pages`/`knowledge_space_overrides`,
   columns `space_id`/`page_id`/`target_space_*`), REST (`/api/v1/knowledge/spaces`,
   `/api/v1/knowledge/pages`), URL routes (`/knowledge/spaces`, `/knowledge/pages/:id`),
   types, components, agent tools (`create_knowledge_page`), and the synthesized listing
   heading (`# Pages`). The backlink graph is unchanged.
   - **Deviation — collections retired (not renamed):** the legacy flat `collection`
     grouping (its UI already removed) could not become `space` without colliding with
     `bundle`→`space`, so its tables, repo/service/routes/types, and the two agent tools
     (`create_knowledge_collection`, `list_knowledge_collections`) were **dropped**.
     `collection` now means only a Postgres/Mongo collection (infra).
2. **Chat REST**: REST surface aligned to `/api/v1/chats*` (entity, table, repo, and
   internal `Conversation` names stay — only the wire path changed).
3. **Resource instance**: agent tools `resource_*`→`record_*`; bare "resource"-as-instance
   wording → "record". REST `/api/v1/resources/:type/:id` and the `ResourceRecord` type
   stay (canonical). The `resource_id` storage column + its `resourceId` (type, id)
   addressing in domain events are kept as part of the unchanged Resources storage layer.
4. **Routine/Run**: already canonical — no concept-meaning `workflow`/`execution` leaks
   existed; remaining uses are the CNCF Serverless Workflow spec and tool-execution.
5. **Integration**: `SoulIntegration.connection`→`config` (file `connection.yaml`→
   `config.yaml`). "connection" now means only a DB pool / SSE stream.
6. **Skill**: `capability`-as-synonym removed from Skill Forge copy.
