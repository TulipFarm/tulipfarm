# TulipFarm Terminology — Canonical Glossary

**Status:** binding. This is the single source of truth for what every concept is
called, at every layer (code, DB, REST, URL, UI, docs). Linked from AGENTS.md —
all agents and contributors MUST follow it. Prescriptive: where a layer disagrees
today, the canonical term wins and the divergence is logged under *Deferred Renames*.

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
| Configured AI persona/worker | **Agent** | `Agent` | `/agents`, `/api/v1/agents` | "Agents" | default instance named `GeneralAssistant` (proper noun, kept) |
| The resource feature | **Resources** | — | `/resources` | "Resources" | umbrella |
| A user-defined schema (Ticket, Customer) | **Resource type** | `ResourceType` | `/resources/:type` | "Resource type" | has a JSON **schema** |
| The JSON Schema artifact of a type | **Schema** | `schema` | `/resources/:type/schema` | "Schema" | |
| A single data instance | **Record** | `Record` | `/resources/:type/:id` | "Record" | ⛔ bare "resource" for an instance is BANNED |
| A scheduled/triggered automation | **Routine** | `Routine` | `/routines`, `/api/v1/routines` | "Routines" | `workflow` = only the CNCF spec-format ref |
| One execution of a routine | **Run** | `Run` | `/routines/:id/runs/:runId` | "Run" | `execution` → retired |
| How a routine starts | **Trigger** | `Trigger` | — | "Trigger" | event·manual·cron·webhook·agent |
| A step in a routine | **State** | `State` | — | "State" | CNCF Serverless Workflow term |
| A connected third-party | **Integration** | `Integration` | `/integrations`, `/api/v1/integrations` | "Integrations" | `connection`/`connector` → retired |
| Auth material for a provider/integration | **Credential** | `Credential` | — | "Credentials" | API key/token/login; *backed by* a Secret |
| Encrypted at-rest value (storage primitive) | **Secret** | `Secret` | `/settings/secrets` | "Secrets" | the store; ≠ Credential |
| An installable agent capability module | **Skill** | `Skill` | `/skills`, `/api/v1/skills` | "Skills" | `plugin`/`capability` → retired as synonyms¹ |
| Where skills are browsed/installed | **Marketplace** / **Install** | — | `/skills/marketplace`, `/skills/install` | "Marketplace" | |
| The git-backed config repo | **Soul** | `Soul` | `/api/v1/soul` | "Soul" | holds agents/routines/skills/integrations/resources |
| The knowledge wiki feature | **Knowledge** | — | `/knowledge` | "Knowledge" | a wiki |
| A grouping of pages | **Space** | `Space` | `/knowledge/spaces/:id` | "Space" | retires `bundle`, `collection`² |
| A knowledge content node | **Page** | `Page` | `/knowledge/pages/:id` | "Page" | retires `concept`, `document`; pages link pages (backlink graph) |
| A runtime human-decision gate | **Approval** | `Approval` | `/approvals`, `/api/v1/approvals` | "Approvals" | not "review"/"request" |
| A policy constraining agent/tool behavior | **Guardrail** | `Guardrail` | `/api/v1/guardrails` | "Guardrails" | `policy`/`rule` are subordinate parts, not the concept |
| A callable function exposed to agents | **Tool** | `Tool` | — | "Tool" | includes MCP tools |
| Durable recalled facts across chats | **Memory** | `Memory` | `/api/v1/memory` | "Memory" | ≠ Context |
| Assembled model-input window for a turn | **Context** | `Context` | — | — | the Context Engine (assembly, compaction); ≠ Memory |
| First-run setup wizard | **Onboarding** | `Onboarding` | `/onboarding` | "Onboarding" | |
| Model Context Protocol (external tool servers) | **MCP** | `MCP` | — | "MCP" | acronym, verbatim |
| Agent-to-UI rendering protocol | **A2UI** | `A2UI` | `/dev/a2ui` | "A2UI" | acronym, verbatim |

¹ `plugin` remains valid ONLY for build/library tooling (vite, rehype, Chart.js) — never for a Skill.
² `collection` is reserved exclusively for "a MongoDB collection" (infra). It never means a knowledge grouping.

## Banned / retired terms (quick lookup)

| Don't write | Write instead | Where it currently leaks |
|---|---|---|
| conversation (in UI/URL/REST) | chat | — |
| chat (in entity/DB/domain) | conversation | — |
| resource (meaning one instance) | record | code |
| workflow (meaning a routine) | routine | code/spec |
| execution (of a routine) | run | code |
| connection / connector | integration | code |
| plugin (meaning a skill) | skill | — |
| capability (meaning a skill) | skill | spec |
| bundle | space | UI/URL/code |
| collection (meaning a knowledge group) | space | UI/code |
| concept (knowledge node) | page | UI/URL/code |
| document (knowledge node) | page | spec/DB/tools |

## Deferred Renames (refactor backlog — prescriptive consequences)

These are the cross-layer mismatches this doc resolves on paper; the code catch-up
is tracked, not done here:

1. **Knowledge → Space/Page** (largest): rename `bundle`→`space`, `concept`→`page`
   in UI/routes/URL/code; `collection`→`space`, `document`→`page` in spec/DB/agent
   tools (`create_knowledge_collection`→`create_knowledge_space`, etc.). Graph stays.
2. **Chat REST**: `conversation-routes.ts` REST surface → align to `/api/v1/chats`
   (entity stays `Conversation` internally).
3. **Resource instance**: purge bare "resource"-as-instance usages → "record".
4. **Routine**: purge "workflow"/"execution" as concept words → "routine"/"run".
5. **Integration**: purge "connection"/"connector" as concept words → "integration".

Each becomes its own ticket; none block adopting this glossary for NEW work.
