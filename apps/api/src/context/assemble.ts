import { buildGovernanceBlock } from "../knowledge/governance";
import type { KnowledgeDocument } from "../knowledge/types";
import { MAX_TOTAL_CHARS } from "../memory/limits";
import type { WorkingMemoryDoc } from "../memory/working-memory";
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
  /** The agent's AGENT.md body. */
  personality?: string;
  /** Per-user working memory, store-capped, oldest-written first (MEM-V1-003). */
  memory: WorkingMemoryDoc[];
  /** Active `alwaysLoadForAgents` knowledge docs (KN-V1-005). */
  governanceDocs: KnowledgeDocument[];
  /**
   * Eager skill bodies for `<skills>` — skills with `eager: true` in their SKILL.md frontmatter.
   * Their full body is included in the prompt so the agent can apply them without a `load_skill`
   * call. Unset or empty → block omitted.
   */
  eagerSkills?: EagerSkill[];
  /**
   * Lazy skill L1 index for `<available-skills>` — non-eager soul skills projected to name +
   * description. The agent pulls a skill's body (L2) on demand via `load_skill`. Unset → block omitted.
   */
  availableSkills?: AvailableSkill[];
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

function renderAgentPersonality(ctx: AssembleContext): string {
  const body = ctx.personality?.trim();
  return body ? block("agent-personality", body) : "";
}

/**
 * `<memory>` block (MEM-V1-003). Each entry is one `- key: value` line in store order. Budget is
 * the store's own metric — total key+value chars; over `MAX_TOTAL_CHARS` the whole block is
 * dropped (never half-rendered). Entries already pass write-time caps, so this is a defensive floor.
 */
function renderMemory(ctx: AssembleContext): string {
  if (ctx.memory.length === 0) return "";
  const total = ctx.memory.reduce((n, e) => n + e.key.length + e.value.length, 0);
  if (total > MAX_TOTAL_CHARS) return "";
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
 * `<available-skills>` budget — total chars across all `name`+`description` pairs. Over this the whole
 * block is dropped (never half-rendered) so the cacheable prefix can't drift mid-block, matching
 * `renderMemory`. Defensive: V1 skill counts sit well under it.
 */
const MAX_AVAILABLE_SKILLS_CHARS = 8000;

/**
 * `<available-skills>` block (SKILLS.md, CONTEXT-ENGINE §1). The lazy skill L1 index: one
 * `- name: description` line per soul skill (just `- name` when the skill declares no description),
 * in the registry's sorted order. The agent loads a skill's body (L2) on demand via `load_skill`.
 * Omitted entirely when no skills are available; dropped whole when over budget.
 */
function renderAvailableSkills(ctx: AssembleContext): string {
  const skills = ctx.availableSkills ?? [];
  if (skills.length === 0) return "";
  const total = skills.reduce((n, s) => n + s.name.length + s.description.length, 0);
  if (total > MAX_AVAILABLE_SKILLS_CHARS) return "";
  const body = skills
    .map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`))
    .join("\n");
  return block("available-skills", body);
}

/**
 * Assemble the agent system prompt from the 9 ordered blocks (specs/CONTEXT-ENGINE.md §1). Pure
 * and synchronous. Each block renders to a string or "" (when empty, over budget, or deferred);
 * empty blocks are omitted entirely so the prefix stays byte-stable across turns. `<skills>` renders
 * eager skill bodies and `<available-skills>` the lazy skill L1 index; the still-deferred blocks —
 * `<soul-context>`, `<available-tools>` — emit empty until the soul L1 snapshot and Tools land. No
 * `<harness-typed-state>` block is ever emitted (deferred MEM-V1-005, AC-V1-003).
 */
export function assembleSystemPrompt(ctx: AssembleContext): string {
  const blocks = [
    renderPlatformInstructions(ctx),
    renderAgentIdentity(ctx),
    renderAgentPersonality(ctx),
    renderMemory(ctx),
    // V1: governance is tenant-wide. `domain` is display-only on the agent (AGT-V1-007), so it
    // feeds <agent-identity> but does NOT scope governance — preserving prior behavior.
    buildGovernanceBlock(ctx.governanceDocs, null),
    renderEagerSkills(ctx),
    renderAvailableSkills(ctx),
    "", // <soul-context> — deferred (soul L1 snapshot builder)
    "", // <available-tools> — deferred (Tools v0.8)
  ];
  return blocks.filter((b) => b.length > 0).join("\n");
}
