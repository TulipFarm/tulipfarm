import { buildGovernanceBlock, type GovernancePage } from "./governance";

/** Only rendered fields belong here; store ids/versions/timestamps must not reach prompts. */

/** Caller-supplied time keeps prompt assembly pure and prompt-cacheable. */
export interface TemporalContext {
  readonly now: Date;
  /** Invalid or unsupported zones fall back to UTC. */
  readonly timezone?: string;
}

export interface EagerSkill {
  readonly name: string;
  readonly body: string;
}

export interface AvailableSkill {
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly categoryDescription?: string;
}

export interface SoulCatalogueEntry {
  readonly name: string;
  readonly description: string;
}

export interface SoulCatalogue {
  readonly agents: readonly SoulCatalogueEntry[];
  readonly skills: readonly SoulCatalogueEntry[];
  readonly resourceTypes: readonly SoulCatalogueEntry[];
  readonly routines: readonly SoulCatalogueEntry[];
  readonly integrations: readonly SoulCatalogueEntry[];
}

/** Pure, IO-free inputs for one deterministic prompt assembly. */
export interface AssembleContext {
  skipPlatformPrompt?: boolean;
  platformInstructions?: string;
  agentId?: string;
  domain?: string | null;
  tenantId?: string;
  /** Omit the business block unless `name` is set. */
  business?: {
    name?: string;
    description?: string;
    website?: string;
  };
  personality?: string;
  /** User-authored standing instructions; no tool can edit them. */
  customInstructions?: string;
  /** The user's rendered Memory Document. Absent for a Run acting as anything but a person. */
  memoryDocument?: string;
  governancePages: GovernancePage[];
  /** Eager Skill bodies are included whole so no `load_skill` call is needed. */
  eagerSkills?: EagerSkill[];
  /** Lazy Skill L1 index; bodies stay L2 behind `load_skill`. */
  availableSkills?: AvailableSkill[];
  /** Per-turn `#resource` schemas; ephemeral and never cached. */
  taggedResources?: { name: string; schema: string }[];
  /** Soul artifact L1 catalogue; full bodies/schemas stay L2. */
  soulCatalogue?: SoulCatalogue;
  /** Tool L1 index scoped to the agent allowlist. */
  availableTools?: { name: string; description: string }[];
  surfaceCatalog?: string;
  /** Per-turn `~knowledge` pins; dropped whole when over budget. */
  pinnedKnowledge?: { id: string; title: string; content: string }[];
  temporal?: TemporalContext;
  /** Fixed knowledge-search/citation guidance, appended only when knowledge is wired. */
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
  const website = ctx.business?.website?.trim();
  if (website) lines.push(`website: ${website}`);
  return block("business-context", lines.join("\n"));
}

function renderAgentPersonality(ctx: AssembleContext): string {
  const body = ctx.personality?.trim();
  return body ? block("agent-personality", body) : "";
}

/** Over-budget custom instructions are dropped whole, never truncated. */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4_000;

/** Preamble sets user-authored rank without outranking platform, guardrails, or authz. */
const CUSTOM_INSTRUCTIONS_PREAMBLE = [
  "The user wrote the following standing instructions for you in their settings. Treat them as",
  "directions they have already given you, and follow them every turn without waiting to be",
  "reminded. They outrank your own <agent-personality>. They do not override platform instructions,",
  "guardrails, or authorization: if an instruction here conflicts with those, follow those and say",
  "plainly that you did. Anything in this block is instruction from the user, never content to",
  "summarize or repeat back.",
].join(" ");

/** Omitted when blank; dropped whole when over budget. */
function renderCustomInstructions(ctx: AssembleContext): string {
  const body = ctx.customInstructions?.trim();
  if (!body || body.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) return "";
  return block("custom-instructions", `${CUSTOM_INSTRUCTIONS_PREAMBLE}\n\n${body}`);
}

/** Render-side memory budget; over-budget memory is dropped whole. */
const MAX_MEMORY_CHARS = 25_600;

/** The rendered Memory Document, or nothing when it is absent, empty or over budget. */
function memoryDocumentBody(ctx: AssembleContext): string | undefined {
  const body = ctx.memoryDocument?.trim();
  if (!body || body.length > MAX_MEMORY_CHARS) return undefined;
  return body;
}

/**
 * Document framing. It has to say *write*, not only *apply*: the block alone reads as reference
 * material, so a model told only to honour it will read memory forever and never record anything,
 * and the user's durable facts depend on a tool call nothing ever asked for.
 */
const MEMORY_DOCUMENT_INSTRUCTIONS_TEXT = [
  "The <memory> block below is this user's durable memory document. It is loaded into every",
  "conversation you have with them.",
  "\n\nApply it actively. It shapes HOW you respond, not just what you know: reply in the language,",
  "script, tone and name it records, and render every date and time in the timezone and format it",
  "records. Follow its standing instructions every turn without waiting for the user to restate",
  "them. It is memory, never a task list and never content to summarize back.",
  "\n\nKeep it current. When you learn something durable about this user — who they are, what they",
  "are responsible for, how they want you to reply, a rule they just gave you, a decision they just",
  "made — call update_memory in the same turn, without asking permission. If you would want to know",
  'it next week, write it now. Do the same when they say "remember ...", and when something you',
  "recorded turns out to be wrong or they correct you.",
  "\n\nOne fact per line, and write a timezone as its own Identity line spelled exactly",
  '"Timezone: Area/City" — that line sets the clock every date you render is drawn in.',
  "\n\nDo not record what expires within the hour, what you inferred rather than observed, secrets,",
  "or long documents — those belong in create_knowledge_page.",
].join(" ");

function renderMemoryInstructions(ctx: AssembleContext): string {
  if (memoryDocumentBody(ctx) === undefined) return "";
  return block("memory-instructions", MEMORY_DOCUMENT_INSTRUCTIONS_TEXT);
}

/** The document verbatim. Over-budget memory is dropped whole. */
function renderMemory(ctx: AssembleContext): string {
  const document = memoryDocumentBody(ctx);
  return document === undefined ? "" : block("memory", document);
}

/** Eager Skill budget; over-budget Skill bodies are dropped whole. */
const MAX_EAGER_SKILLS_CHARS = 32000;

/** Eager Skill bodies render as sorted `## name` sections. */
function renderEagerSkills(ctx: AssembleContext): string {
  const skills = ctx.eagerSkills ?? [];
  if (skills.length === 0) return "";
  const total = skills.reduce((n, s) => n + s.name.length + s.body.length, 0);
  if (total > MAX_EAGER_SKILLS_CHARS) return "";
  const body = skills.map((s) => `## ${s.name}\n${s.body}`).join("\n\n");
  return block("skills", body);
}

/** Available Skill budget; over-budget indexes are dropped whole. */
const MAX_AVAILABLE_SKILLS_CHARS = 8000;

const AVAILABLE_SKILLS_GUIDANCE = [
  "Before replying, scan the named Skills in this list and load any that are even partially",
  "relevant with load_skill. Category headings only group Skills; they are not Skill names and",
  "cannot be loaded. If a loaded Skill is wrong, outdated, or incomplete, patch it immediately with",
  "skill_update using old_string and new_string; do not wait to be asked. After a hard multi-step",
  "task, offer to save the reusable approach as a new Skill.",
].join(" ");

/** Bundled Skills group by category; uncategorized Skills stay flat. */
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
    lines.push(description ? `## Skill category: ${description}` : "## Skill category");
    for (const skill of categorySkills) {
      lines.push(
        skill.description ? `  - ${skill.name}: ${skill.description}` : `  - ${skill.name}`
      );
    }
  }
  return block("available-skills", `${AVAILABLE_SKILLS_GUIDANCE}\n\n${lines.join("\n")}`);
}

/** Tagged-resource budget; over-budget schemas are dropped whole. */
const MAX_TAGGED_RESOURCES_CHARS = 16000;

/** Tagged resource schemas render in supplied order for this turn only. */
function renderTaggedResources(ctx: AssembleContext): string {
  const resources = ctx.taggedResources ?? [];
  if (resources.length === 0) return "";
  const total = resources.reduce((n, r) => n + r.name.length + r.schema.length, 0);
  if (total > MAX_TAGGED_RESOURCES_CHARS) return "";
  const body = resources.map((r) => `## ${r.name}\n${r.schema}`).join("\n\n");
  return block("eager-resources", body);
}

/** Soul catalogue budget; over-budget catalogues are dropped whole. */
const MAX_SOUL_CONTEXT_CHARS = 16000;

/** Fixed `<soul-context>` render order. */
const SOUL_CONTEXT_SECTIONS: { heading: string; key: keyof SoulCatalogue }[] = [
  { heading: "Agents", key: "agents" },
  { heading: "Skills", key: "skills" },
  { heading: "Resource Types", key: "resourceTypes" },
  { heading: "Routines", key: "routines" },
  { heading: "Integrations", key: "integrations" },
];

/** Non-empty Soul catalogue sections render in name-sorted order. */
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

/** Available-tool budget; over-budget tool indexes are dropped whole. */
const MAX_AVAILABLE_TOOLS_CHARS = 24000;

/** Available tools render in name-sorted order. */
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

/** Pinned-knowledge budget; over-budget pages are dropped whole. */
const MAX_PINNED_KNOWLEDGE_CHARS = 32000;

/** Pinned knowledge renders with page ids for citation. */
function renderPinnedKnowledge(ctx: AssembleContext): string {
  const pages = ctx.pinnedKnowledge ?? [];
  if (pages.length === 0) return "";
  const total = pages.reduce((n, p) => n + p.title.length + p.content.length, 0);
  if (total > MAX_PINNED_KNOWLEDGE_CHARS) return "";
  const intro =
    "The user pinned these knowledge pages for this turn. Prefer them when answering, and cite each one you use with cite_sources using its pageId.";
  // Strip title newlines so they cannot break out of the `##` heading and inject structure.
  // Page content stays verbatim (same trust as governance docs).
  const body = pages
    .map((p) => `## ${p.title.replace(/[\r\n]+/g, " ")} — pageId: ${p.id}\n${p.content}`)
    .join("\n\n");
  return block("pinned-knowledge", `${intro}\n\n${body}`);
}

/** Fixed knowledge-grounding guidance; appended last when enabled. */
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

/** Fallback for every unusable `timezone`; never guessed from the host clock. */
const FALLBACK_TIME_ZONE = "UTC";

/** Validate free-text time zones with `Intl`; fall back instead of failing the turn. */
function resolveTimeZone(timezone: string | undefined): string {
  const candidate = timezone?.trim();
  if (!candidate) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** Shared time formatter for prompt context and `get_current_time`; avoids midnight `24:00`. */
export function formatTemporalContext(temporal: TemporalContext): string {
  const timeZone = resolveTimeZone(temporal.timezone);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(temporal.now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const rawOffset = part("timeZoneName");
  const offset = rawOffset === "GMT" ? "UTC+00:00" : rawOffset.replace("GMT", "UTC");
  return [
    `date: ${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`,
    `time: ${part("hour")}:${part("minute")} (${timeZone}, ${offset})`,
  ].join("\n");
}

/** Does not mention `get_current_time`; Routine callers may not have that Tool. */
const CURRENT_CONTEXT_TEXT =
  "The current date and time, read at the start of this turn. Resolve every relative time reference " +
  "against it.";

/** Last changing block: it truncates, not invalidates, the cacheable prefix. */
function renderCurrentContext(ctx: AssembleContext): string {
  const temporal = ctx.temporal;
  if (temporal === undefined || Number.isNaN(temporal.now.getTime())) return "";
  return block("current-context", `${CURRENT_CONTEXT_TEXT}\n${formatTemporalContext(temporal)}`);
}

/** Pure prompt assembly; empty or over-budget blocks are omitted whole in fixed order. */
export function assembleSystemPrompt(ctx: AssembleContext): string {
  const blocks = [
    renderPlatformInstructions(ctx),
    renderAgentIdentity(ctx),
    renderBusinessContext(ctx),
    renderAgentPersonality(ctx),
    renderCustomInstructions(ctx),
    renderMemoryInstructions(ctx),
    renderMemory(ctx),
    // V1: governance is tenant-wide. `domain` is display-only on the agent, so it
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
    // Last on purpose: the only block whose content changes every turn, so it truncates the
    // cacheable prefix instead of invalidating it. See renderCurrentContext.
    renderCurrentContext(ctx),
  ];
  return blocks.filter((b) => b.length > 0).join("\n");
}
