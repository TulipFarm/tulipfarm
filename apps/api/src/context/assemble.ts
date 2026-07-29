import { buildGovernanceBlock } from "../knowledge/governance";
import type { KnowledgePage } from "../knowledge/types";
import { MAX_TOTAL_CHARS } from "../memory/limits";
import type { WorkingMemoryDoc } from "../memory/working-memory";
import type { SoulCatalogue } from "../soul/catalogue";
import type { AvailableSkill, EagerSkill } from "../soul/skills/registry";

/**
 * Resolved inputs for one turn's system prompt. `assembleSystemPrompt` is pure — the caller
 * fetches everything from durable stores and passes it here; assembly performs no IO. Keeping
 * the inputs resolved (not lazily fetched) is what makes the rendered prefix deterministic and
 * therefore prompt-cacheable (AC-V1-001).
 */
export interface AssembleContext {
  /** Omit the `<platform-instructions>` block for this turn even if text is supplied. */
  skipPlatformPrompt?: boolean;
  /** Platform base prompt text. Unset in V1 → block omitted. */
  platformInstructions?: string;
  agentId?: string;
  /** AGENT.md frontmatter domain — display-only (AGT-V1-007); renders in <agent-identity> only. */
  domain?: string | null;
  /** Single-tenant V1: "default". */
  tenantId?: string;
  /**
   * soul.yaml manifest's business profile — surfaces as `<business-context>`. `name` unset → block
   * omitted; other fields render as `key: value` lines only when set. Grouped in one object so new
   * profile fields (industry, website, ...) only touch this shape and the renderer, not every
   * call site between `soulLoader.manifest` and here.
   */
  business?: {
    name?: string;
    description?: string;
  };
  /** The agent's AGENT.md body. */
  personality?: string;
  /** Per-user working memory, store-capped, oldest-written first (MEM-V1-003). */
  memory: WorkingMemoryDoc[];
  /** Active `alwaysLoadForAgents` knowledge docs (KN-V1-005). */
  governancePages: KnowledgePage[];
  /**
   * Eager skill bodies for `<skills>` — skills with `eager: true` in their SKILL.md frontmatter.
   * Their full body is included in the prompt so the agent can apply them without a `load_skill`
   * call. Unset or empty → block omitted.
   */
  eagerSkills?: EagerSkill[];
  /**
   * Lazy Skill L1 index for `<available-skills>` — non-eager Skills projected to name,
   * description, and optional bundled category metadata. The agent pulls a Skill's body (L2) on
   * demand via `load_skill`. Unset → block omitted.
   */
  availableSkills?: AvailableSkill[];
  /**
   * Per-turn tagged resource types (`#resource` in the composer). Each entry is a resource type's
   * name + its schema text, injected verbatim into `<eager-resources>` so the agent can create or
   * reason over records of that type without a tool round-trip. Ephemeral — set per turn, never cached.
   */
  taggedResources?: { name: string; schema: string }[];
  /**
   * L1 repo catalogue for `<soul-context>` — every soul artifact (agents, skills, resource types,
   * routines, integrations) projected to name + description. Gives the agent ambient awareness of
   * what already exists; full bodies/schemas stay L2 (pulled on demand). Unset → block omitted.
   */
  soulCatalogue?: SoulCatalogue;
  /**
   * L1 index of the tools this agent may call for `<available-tools>` — name + one-line description,
   * scoped to the agent's allowlist (the same set used to build its toolset). Unset → block omitted.
   */
  availableTools?: { name: string; description: string }[];
  /** Generated catalog guidance, supplied only for the server-assigned web UI channel. */
  surfaceCatalog?: string;
  /**
   * Per-turn `~knowledge` pins from the composer — full page content the user explicitly attached for
   * this turn, injected into `<pinned-knowledge>`. Each carries its pageId so the agent can cite
   * it with `cite_sources`. Ephemeral (varies per turn); dropped whole when over budget.
   */
  pinnedKnowledge?: { id: string; title: string; content: string }[];
  /**
   * When true, append the `<knowledge-grounding>` block instructing the agent to search stored
   * knowledge (`query_knowledge`) and cite the pages it used (`cite_sources`). Set per turn only
   * when a knowledge service is wired, so knowledge-less souls never see it. Fixed text → the block
   * stays byte-stable and is appended last, leaving the rest of the prefix untouched when off.
   */
  knowledgeGrounding?: boolean;
}

function block(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

function renderPlatformInstructions(ctx: AssembleContext): string {
  if (ctx.skipPlatformPrompt) return "";
  const text = ctx.platformInstructions?.trim();
  return text ? block("platform-instructions", text) : "";
}

function renderAgentIdentity(ctx: AssembleContext): string {
  const lines: string[] = [];
  if (ctx.agentId) lines.push(`agentId: ${ctx.agentId}`);
  if (ctx.domain) lines.push(`domain: ${ctx.domain}`);
  if (ctx.tenantId) lines.push(`tenantId: ${ctx.tenantId}`);
  return lines.length > 0 ? block("agent-identity", lines.join("\n")) : "";
}

function renderBusinessContext(ctx: AssembleContext): string {
  const name = ctx.business?.name?.trim();
  if (!name) return "";
  const lines = [`name: ${name}`];
  const description = ctx.business?.description?.trim();
  if (description) lines.push(`description: ${description}`);
  return block("business-context", lines.join("\n"));
}

function renderAgentPersonality(ctx: AssembleContext): string {
  const body = ctx.personality?.trim();
  return body ? block("agent-personality", body) : "";
}

/**
 * True when the `<memory>` block will render this turn: memory is non-empty and within budget.
 * Shared by `renderMemoryInstructions` and `renderMemory` so the static preamble never orphans —
 * it appears exactly when the entry block does.
 */
function memoryRenders(ctx: AssembleContext): boolean {
  if (ctx.memory.length === 0) return false;
  const total = ctx.memory.reduce((n, e) => n + e.key.length + e.value.length, 0);
  return total <= MAX_TOTAL_CHARS;
}

/**
 * Fixed behavioral framing for the `<memory>` entries — tells the agent to *apply* preference-typed
 * facts (language, tone, format, timezone), not just know them. Kept as static text in its own
 * block so it stays byte-stable (prompt-cacheable) even as the entry list below it changes.
 */
const MEMORY_INSTRUCTIONS_TEXT = [
  "The <memory> block below holds durable personal facts and preferences for this user. Apply them",
  "actively: preference entries shape HOW you respond, not just what you know. In particular, reply",
  "in the user's preferred_language using that language's native script (e.g. Devanagari for Hindi)",
  "unless the stored value specifies a romanized or transliterated form; match their reply_tone,",
  "address them by preferred_name, and render every date and time in their timezone and date_format.",
  "Honor these every turn without waiting for the user to restate them.",
].join(" ");

/**
 * `<memory-instructions>` block. Static preamble (no interpolation → byte-stable) rendered directly
 * before `<memory>` whenever memory renders. Gated on the same condition as `renderMemory` so an
 * empty or over-budget memory never leaves an orphan preamble.
 */
function renderMemoryInstructions(ctx: AssembleContext): string {
  return memoryRenders(ctx) ? block("memory-instructions", MEMORY_INSTRUCTIONS_TEXT) : "";
}

/**
 * `<memory>` block (MEM-V1-003). Each entry is one `- key: value` line in store order. Budget is
 * the store's own metric — total key+value chars; over `MAX_TOTAL_CHARS` the whole block is
 * dropped (never half-rendered). Entries already pass write-time caps, so this is a defensive floor.
 */
function renderMemory(ctx: AssembleContext): string {
  if (!memoryRenders(ctx)) return "";
  const body = ctx.memory.map((e) => `- ${e.key}: ${e.value}`).join("\n");
  return block("memory", body);
}

/**
 * `<skills>` budget — total chars across all eager skill `name`+`body` pairs. Over this the whole
 * block is dropped (never half-rendered). Skill bodies can be large (multi-page playbooks), so the
 * budget is generous; drop-whole prevents a partial-body from reaching the agent.
 */
const MAX_EAGER_SKILLS_CHARS = 32000;

/**
 * `<skills>` block (CONTEXT-ENGINE §1). Renders eager skill bodies so the agent can apply them
 * without a `load_skill` call. One `## name\nbody` section per skill, in sorted order.
 * Omitted when no eager skills are supplied; dropped whole when over budget.
 */
function renderEagerSkills(ctx: AssembleContext): string {
  const skills = ctx.eagerSkills ?? [];
  if (skills.length === 0) return "";
  const total = skills.reduce((n, s) => n + s.name.length + s.body.length, 0);
  if (total > MAX_EAGER_SKILLS_CHARS) return "";
  const body = skills.map((s) => `## ${s.name}\n${s.body}`).join("\n\n");
  return block("skills", body);
}

/**
 * `<available-skills>` budget — total chars across every name, description, category, and category
 * description. Over this the whole block is dropped (never half-rendered) so the cacheable prefix
 * cannot drift mid-block, matching `renderMemory`.
 */
const MAX_AVAILABLE_SKILLS_CHARS = 8000;

const AVAILABLE_SKILLS_GUIDANCE = [
  "Before replying, scan this list and load any Skill that is even partially relevant with",
  "load_skill. If a loaded Skill is wrong, outdated, or incomplete, patch it immediately with",
  "skill_update using old_string and new_string; do not wait to be asked. After a hard multi-step",
  "task, offer to save the reusable approach as a new Skill.",
].join(" ");

/**
 * `<available-skills>` block (SKILLS.md, CONTEXT-ENGINE §1). Bundled Skills are grouped beneath
 * category headers; uncategorized Soul Skills retain the flat `- name: description` form. Input
 * order within each group remains the registry's stable name sort.
 */
function renderAvailableSkills(ctx: AssembleContext): string {
  const skills = ctx.availableSkills ?? [];
  if (skills.length === 0) return "";
  const total =
    AVAILABLE_SKILLS_GUIDANCE.length +
    skills.reduce(
      (n, skill) =>
        n +
        skill.name.length +
        skill.description.length +
        (skill.category?.length ?? 0) +
        (skill.categoryDescription?.length ?? 0),
      0
    );
  if (total > MAX_AVAILABLE_SKILLS_CHARS) return "";

  const lines = skills
    .filter((skill) => !skill.category)
    .map((skill) =>
      skill.description ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`
    );
  const categories = new Map<string, AvailableSkill[]>();
  for (const skill of skills) {
    if (!skill.category) continue;
    const categorySkills = categories.get(skill.category) ?? [];
    categorySkills.push(skill);
    categories.set(skill.category, categorySkills);
  }
  for (const category of [...categories.keys()].sort((left, right) => left.localeCompare(right))) {
    const categorySkills = categories.get(category) ?? [];
    const description =
      categorySkills.find((skill) => skill.categoryDescription)?.categoryDescription ?? "";
    lines.push(description ? `${category}: ${description}` : `${category}:`);
    for (const skill of categorySkills) {
      lines.push(
        skill.description ? `  - ${skill.name}: ${skill.description}` : `  - ${skill.name}`
      );
    }
  }
  return block("available-skills", `${AVAILABLE_SKILLS_GUIDANCE}\n\n${lines.join("\n")}`);
}

/**
 * `<eager-resources>` budget — total chars across all tagged resource `name`+`schema` pairs. Over
 * this the whole block is dropped (never half-rendered), mirroring the other block budgets.
 */
const MAX_TAGGED_RESOURCES_CHARS = 16000;

/**
 * `<eager-resources>` block — resource-type definitions the user tagged with `#` in the composer.
 * One `## name\nschema` section per type, in supplied order, so the agent has the type's shape in
 * front of it for this turn. Omitted when none supplied; dropped whole when over budget.
 */
function renderTaggedResources(ctx: AssembleContext): string {
  const resources = ctx.taggedResources ?? [];
  if (resources.length === 0) return "";
  const total = resources.reduce((n, r) => n + r.name.length + r.schema.length, 0);
  if (total > MAX_TAGGED_RESOURCES_CHARS) return "";
  const body = resources.map((r) => `## ${r.name}\n${r.schema}`).join("\n\n");
  return block("eager-resources", body);
}

/**
 * `<soul-context>` budget — total chars across every catalogue entry's `name`+`description`. Over
 * this the whole block is dropped (never half-rendered), matching the other block budgets. The
 * catalogue spans five artifact types, so the budget is generous; V1 counts sit well under it.
 */
const MAX_SOUL_CONTEXT_CHARS = 16000;

/** The five `<soul-context>` sections, in fixed render order, mapped to their catalogue key. */
const SOUL_CONTEXT_SECTIONS: { heading: string; key: keyof SoulCatalogue }[] = [
  { heading: "Agents", key: "agents" },
  { heading: "Skills", key: "skills" },
  { heading: "Resource Types", key: "resourceTypes" },
  { heading: "Routines", key: "routines" },
  { heading: "Integrations", key: "integrations" },
];

/**
 * `<soul-context>` block (CONTEXT-ENGINE §1). The repo catalogue: a `## Heading` markdown section
 * per artifact type, each with one `- name: description` line (just `- name` when no description),
 * in name-sorted order. Only non-empty sections render; the whole block is omitted when the
 * catalogue is empty and dropped whole when over budget.
 */
function renderSoulContext(ctx: AssembleContext): string {
  const cat = ctx.soulCatalogue;
  if (!cat) return "";
  const total = SOUL_CONTEXT_SECTIONS.reduce(
    (n, s) => n + cat[s.key].reduce((m, e) => m + e.name.length + e.description.length, 0),
    0
  );
  if (total === 0) return "";
  if (total > MAX_SOUL_CONTEXT_CHARS) return "";
  const sections = SOUL_CONTEXT_SECTIONS.filter((s) => cat[s.key].length > 0).map((s) => {
    const lines = cat[s.key]
      .map((e) => (e.description ? `- ${e.name}: ${e.description}` : `- ${e.name}`))
      .join("\n");
    return `## ${s.heading}\n${lines}`;
  });
  return block("soul-context", sections.join("\n\n"));
}

/**
 * `<available-tools>` budget — total chars across all tool `name`+`description` pairs. Over this
 * the whole block is dropped (never half-rendered), matching `renderAvailableSkills`.
 */
const MAX_AVAILABLE_TOOLS_CHARS = 24000;

/**
 * `<available-tools>` block (Tools, CONTEXT-ENGINE §1). The tool L1 index: one `- name: description`
 * line per tool the agent may call (scoped to its allowlist), in name-sorted order. Omitted when
 * the agent has no tools; dropped whole when over budget.
 */
function renderAvailableTools(ctx: AssembleContext): string {
  const tools = ctx.availableTools ?? [];
  if (tools.length === 0) return "";
  const total = tools.reduce((n, t) => n + t.name.length + t.description.length, 0);
  if (total > MAX_AVAILABLE_TOOLS_CHARS) return "";
  const body = tools
    .map((t) => (t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`))
    .join("\n");
  return block("available-tools", body);
}

function renderSurfaceCatalog(ctx: AssembleContext): string {
  const catalog = ctx.surfaceCatalog?.trim();
  return catalog ? block("surface-catalog", catalog) : "";
}

/**
 * `<pinned-knowledge>` budget — total chars across all pinned page `title`+`content` pairs. Over
 * this the whole block is dropped (never half-rendered), mirroring the other block budgets. Pages
 * can be large, so the budget is generous.
 */
const MAX_PINNED_KNOWLEDGE_CHARS = 32000;

/**
 * `<pinned-knowledge>` block — full knowledge pages the user attached this turn via `~knowledge`.
 * One `## title — pageId: id` section per page so the agent can answer from them and cite each
 * via `cite_sources`. Omitted when none pinned; dropped whole when over budget.
 */
function renderPinnedKnowledge(ctx: AssembleContext): string {
  const pages = ctx.pinnedKnowledge ?? [];
  if (pages.length === 0) return "";
  const total = pages.reduce((n, p) => n + p.title.length + p.content.length, 0);
  if (total > MAX_PINNED_KNOWLEDGE_CHARS) return "";
  const intro =
    "The user pinned these knowledge pages for this turn. Prefer them when answering, and cite each one you use with cite_sources using its pageId.";
  // Strip newlines from the (user-authored) title so it can't break out of its `##` heading line and
  // inject structure into the prompt. Page content stays verbatim (same trust as governance docs).
  const body = pages
    .map((p) => `## ${p.title.replace(/[\r\n]+/g, " ")} — pageId: ${p.id}\n${p.content}`)
    .join("\n\n");
  return block("pinned-knowledge", `${intro}\n\n${body}`);
}

/**
 * `<knowledge-grounding>` block. Fixed guidance (no interpolation → byte-stable) telling the agent
 * to ground answers in stored knowledge and cite what it used. Gated on `knowledgeGrounding` so it
 * only renders when a knowledge service is wired for the turn; appended last so the rest of the
 * prefix is unchanged when off. The agentic-search contract: search first, mark claims inline, cite.
 */
const KNOWLEDGE_GROUNDING_TEXT = [
  "When the user asks something that stored knowledge could answer (policies, how-tos, domain facts,",
  "records, or a named page/runbook), ground your answer in stored knowledge by running an",
  "anchor-read-expand-cite loop. Prefer searching over asking the user to clarify: if a request is",
  "terse, abbreviated, or ambiguous but could plausibly be answered from stored knowledge, search with",
  "your best interpretation before asking what they mean. Do not search for greetings or small talk.",
  "ANCHOR: call query_knowledge first with a plain natural-language query. Do not set domain, tags, or",
  "spaceId unless the user explicitly named a space or category — never invent or guess a spaceId or",
  "domain value (there is no 'default' space; an unknown filter matches nothing). When unsure, pass the",
  "query alone with no filters. If a search returns nothing, retry once with simpler, broader keywords",
  "(and no filters); only ask for clarification when that still finds nothing.",
  "READ: query_knowledge returns ranked pages each with a short snippet. Call get_page on the top",
  "hit(s) to read the whole page before answering, and synthesize from the full page, not the snippet.",
  "EXPAND: when one page is not enough, follow at most 1-2 hops via get_backlinks or get_space_graph to",
  "pull in curator-linked neighbors, then get_page those that look relevant. Cap traversal at 2 hops",
  "and stop as soon as you have enough evidence; do not over-expand.",
  "CITE: mark each claim drawn from a source with an inline [n] reference, numbered from 1 in order of",
  "first use. After writing the answer, call cite_sources once with { citations: [{ ref, pageId }] },",
  "mapping each [n] to the pageId of the page it came from. Cite only pages you actually used.",
].join(" ");

function renderKnowledgeGrounding(ctx: AssembleContext): string {
  return ctx.knowledgeGrounding ? block("knowledge-grounding", KNOWLEDGE_GROUNDING_TEXT) : "";
}

/**
 * Assemble the agent system prompt from the 11 ordered blocks (specs/CONTEXT-ENGINE.md §1). Pure
 * and synchronous. Each block renders to a string or "" (when empty or over budget); empty blocks
 * are omitted entirely so the prefix stays byte-stable across turns. `<skills>` renders eager skill
 * bodies and `<available-skills>` the lazy skill L1 index; `<soul-context>` renders the repo
 * catalogue (agents/skills/resource types/routines/integrations) and `<available-tools>` the agent's
 * tool L1 index. No `<harness-typed-state>` block is ever emitted (deferred MEM-V1-005, AC-V1-003).
 */
export function assembleSystemPrompt(ctx: AssembleContext): string {
  const blocks = [
    renderPlatformInstructions(ctx),
    renderAgentIdentity(ctx),
    renderBusinessContext(ctx),
    renderAgentPersonality(ctx),
    renderMemoryInstructions(ctx),
    renderMemory(ctx),
    // V1: governance is tenant-wide. `domain` is display-only on the agent (AGT-V1-007), so it
    // feeds <agent-identity> but does NOT scope governance — preserving prior behavior.
    buildGovernanceBlock(ctx.governancePages, null),
    renderEagerSkills(ctx),
    renderAvailableSkills(ctx),
    renderTaggedResources(ctx),
    renderSoulContext(ctx),
    renderSurfaceCatalog(ctx),
    renderAvailableTools(ctx),
    renderPinnedKnowledge(ctx),
    renderKnowledgeGrounding(ctx),
  ];
  return blocks.filter((b) => b.length > 0).join("\n");
}
