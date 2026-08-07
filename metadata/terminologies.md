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
| A channel sender bound to a TulipFarm account | **Channel link** | `ChannelLink` | `/api/v1/identity/channel-links/*`, `/link-channel` | "Link channel" | stored in external_identity_mappings, provider = integration slug; ⛔ "channel identity" as the *link* — that names the sender side only |
| The single-use invitation that creates one | **Bind link** | `ChannelBind*` | — | "Link your account" | HMAC-signed, 15 min, nonce consumed on redemption; a credential — never logged, never in a query string |
| The single-use link that gives a TulipFarm account its password | **Invite link** | `Invite`, `UserInvite*` | `/api/v1/users/:id/invite`, `/api/v1/auth/invites/*`, `/accept-invite` | "Invite link", "Reset password link" | Random secret, hash-only storage, 7 days, consumed on redemption; re-issuing revokes the outstanding one and is also the password recovery path. ⛔ "temporary password" — none is ever minted. Distinct from a **Bind link**, which links a channel sender, not an account |
| Auth material for a provider/integration | **Credential** | `Credential` | — | "Credentials" | API key/token/login; *backed by* a Secret |
| Encrypted at-rest value (storage primitive) | **Secret** | `Secret` | `/settings/secrets` | "Secrets" | the store; ≠ Credential |
| Boot-time value from `.env`/`process.env` | **Env Config** | — | — | — | restart-required; not all values are secret (e.g. `SOUL_PATH`) — the one genuinely secret value inside it is the KEK (`ENCRYPTION_KEY`), named directly, not by renaming this bucket |
| An installable agent capability module | **Skill** | `Skill` | `/skills`, `/api/v1/skills` | "Skills" | `plugin`/`capability` → retired as synonyms¹ |
| Where skills are browsed/installed | **Marketplace** / **Install** | — | `/skills/marketplace`, `/skills/install` | "Marketplace" | |
| The git-backed config repo | **Soul** | `Soul` | `/api/v1/soul` | "Soul" | holds agents/routines/skills/integrations/resources |
| Git-tracked YAML settings inside the Soul repo | **Soul Config** | `SoulConfig` | — | — | e.g. `soul.yaml`, `llm.config.yaml`; non-secret, runtime-editable but reload behavior varies (some apply on `soul.synced`, others require restart) |
| The knowledge wiki feature | **Knowledge** | — | `/knowledge` | "Knowledge" | a wiki |
| A grouping of pages | **Space** | `Space` | `/knowledge/spaces/:id` | "Space" | retires `bundle`, `collection`²; DB: knowledge_spaces, knowledge_space_overrides |
| A knowledge content node | **Page** | `Page` | `/knowledge/pages/:id` | "Page" | retires `concept`, `document`; pages link pages (backlink graph); DB: knowledge_pages |
| A runtime human-decision gate | **Approval** | `Approval` | `/approvals`, `/api/v1/approvals` | "Approvals" | not "review"/"request" |
| A policy constraining agent/tool behavior | **Guardrail** | `Guardrail` | `/api/v1/guardrails` | "Guardrails" | `policy`/`rule` are subordinate parts, not the concept |
| A callable function exposed to agents | **Tool** | `Tool` | — | "Tool" | includes MCP tools |
| Durable recalled facts across chats | **Memory** | `Memory` | `/api/v1/memory` | "Memory" | ≠ Context |
| Assembled model-input window for a turn | **Context** | `Context` | — | — | the Context Engine (assembly, compaction); ≠ Memory |
| First-run setup wizard | **Onboarding** | `Onboarding` | `/onboarding` | "Onboarding" | |
| Model Context Protocol (external tool servers) | **MCP** | `MCP` | — | "MCP" | acronym, verbatim |
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
