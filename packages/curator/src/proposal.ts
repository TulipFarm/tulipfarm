/**
 * What the Curator is allowed to suggest, and every word the user sees when it does.
 *
 * The model chooses a `kind` from a closed set and names a subject. It authors none of the text.
 * That is not stylistic: tapping a pill inserts its prompt straight into the user's next Chat
 * turn, so model-authored text there would be a direct injection path into their own context.
 */

/** The six suggestions the Curator can make. Adding one is a deliberate product decision. */
export const PROPOSAL_KINDS = [
  "create_resource_type",
  "create_agent_for_resource",
  "create_agent_for_integration",
  "add_skill_to_agent",
  "add_knowledge_for_agent",
  "automate_resource_type",
] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * What a Proposal points at. `resource_template` is the one kind naming something that does not
 * exist yet, which is why its ids come from a closed menu below rather than from the model.
 */
export const PROPOSAL_SUBJECT_KINDS = [
  "resource_template",
  "resource_type",
  "integration",
  "agent",
] as const;

export type ProposalSubjectKind = (typeof PROPOSAL_SUBJECT_KINDS)[number];

/** Where a Proposal is shown. A pill-only Proposal must never appear in the Tasks list. */
export const PROPOSAL_DELIVERIES = ["task", "pill"] as const;
export type ProposalDelivery = (typeof PROPOSAL_DELIVERIES)[number];

/**
 * The subject kind each proposal kind takes. The model never sends a subject kind — it follows
 * from the proposal kind, so one fewer field can be wrong and the dedupe key stays server-derived.
 */
export const PROPOSAL_SUBJECT_KIND: Record<ProposalKind, ProposalSubjectKind> = {
  create_resource_type: "resource_template",
  create_agent_for_resource: "resource_type",
  create_agent_for_integration: "integration",
  add_skill_to_agent: "agent",
  add_knowledge_for_agent: "agent",
  automate_resource_type: "resource_type",
};

/**
 * The Resource types the Curator may offer to create, replacing the static onboarding catalog.
 * A closed menu because this is the only subject the model names before it exists; free text here
 * would put model output in a pill prompt.
 */
export const RESOURCE_TEMPLATES: Readonly<Record<string, string>> = {
  tickets: "ticket management",
  leads: "sales leads",
  employees: "employee management",
  invoices: "invoices and billing",
  inventory: "inventory tracking",
  projects: "projects and tasks",
};

/** Reserved dedupe-key namespace. Enforced, not conventional — no other producer may write it. */
export const CURATOR_DEDUPE_PREFIX = "curator:";

/**
 * Derived from the proposal's identity, never from model text, so rephrasing a suggestion cannot
 * resurrect one the user already dismissed.
 */
export function curatorDedupeKey(kind: ProposalKind, subjectId: string): string {
  return `${CURATOR_DEDUPE_PREFIX}${kind}:${PROPOSAL_SUBJECT_KIND[kind]}:${subjectId}`;
}

export function isCuratorDedupeKey(key: string): boolean {
  return key.startsWith(CURATOR_DEDUPE_PREFIX);
}

/** A Proposal with its subject resolved: the label is the server's, read from Soul or the menu. */
export interface ResolvedProposal {
  readonly kind: ProposalKind;
  readonly subjectId: string;
  readonly subjectLabel: string;
}

/**
 * Structurally the two `TaskAction` variants the Curator can produce. Declared here rather than
 * imported so this package stays free of storage; `typecheck` fails at the call site if the two
 * ever drift apart.
 */
export type ProposalAction =
  | { readonly kind: "chat"; readonly prompt: string }
  | { readonly kind: "link"; readonly href: string };

export interface ProposalTemplate {
  readonly title: string;
  readonly detail: string;
  readonly label: string;
  readonly action: ProposalAction;
}

const SUBJECT_LABEL_MAX = 60;

/**
 * A Soul artifact's name is the user's own text, and it ends up inside a prompt that is inserted
 * into their next turn. Collapsing it to a single short line means a Resource named with an
 * embedded instruction block cannot restructure that prompt.
 */
export function safeSubjectLabel(raw: string): string {
  const flat = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the whole point.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SUBJECT_LABEL_MAX ? `${flat.slice(0, SUBJECT_LABEL_MAX - 1)}…` : flat;
}

type TemplateFn = (label: string) => ProposalTemplate;

const TEMPLATES: Record<ProposalKind, TemplateFn> = {
  create_resource_type: (label) => ({
    title: `Set up ${label}`,
    detail: `Tulip can build ${label} for you and keep it running.`,
    label: `Set up ${label}?`,
    action: { kind: "chat", prompt: `Help me set up ${label}.` },
  }),
  create_agent_for_resource: (label) => ({
    title: `Create an agent for ${label}`,
    detail: `${label} has no agent working it, so nothing happens without you.`,
    label: `Create an agent for ${label}?`,
    action: { kind: "chat", prompt: `Help me create an agent to work my ${label}.` },
  }),
  create_agent_for_integration: (label) => ({
    title: `Create an agent for ${label}`,
    detail: `${label} is connected but no agent acts on what arrives from it.`,
    label: `Put an agent on ${label}?`,
    action: { kind: "chat", prompt: `Help me create an agent that works my ${label} integration.` },
  }),
  add_skill_to_agent: (label) => ({
    title: `Give ${label} a skill`,
    detail: `${label} can only do what its skills let it do.`,
    label: `Add a skill to ${label}?`,
    action: { kind: "chat", prompt: `Help me add a skill to my ${label} agent.` },
  }),
  add_knowledge_for_agent: (label) => ({
    title: `Give ${label} something to read`,
    detail: `${label} has no knowledge to cite, so it answers from nothing.`,
    label: `Add knowledge for ${label}?`,
    action: { kind: "chat", prompt: `Help me add a knowledge page for my ${label} agent.` },
  }),
  automate_resource_type: (label) => ({
    title: `Automate ${label}`,
    detail: `A routine can handle the repeated work on ${label} without you asking.`,
    label: `Automate ${label}?`,
    action: { kind: "chat", prompt: `Help me automate the repeated work on my ${label}.` },
  }),
};

/** Every user-facing string a Proposal produces. Total over the closed kind set. */
export function templateProposal(proposal: ResolvedProposal): ProposalTemplate {
  return TEMPLATES[proposal.kind](safeSubjectLabel(proposal.subjectLabel));
}
