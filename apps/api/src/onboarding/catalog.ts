/*
 * Static seed catalog for the Information Architect suggestion layer (ONBOARDING ONB-V1-002/003).
 * Each entry is a candidate onboarding suggestion. `resources` is the match key: the resource
 * name(s) the suggestion would create — an entry is hidden once any of them already exists in the
 * soul (AC-V1-002). `label` is the chip text; `prompt` is the message seeded into chat on tap.
 */

export interface SuggestionEntry {
  /** Stable id, e.g. "tickets". */
  id: string;
  /** Chip text shown to the user. */
  label: string;
  /** Message sent to chat when the chip is tapped. */
  prompt: string;
  /** Resource name(s) this suggestion would create; hide the entry if any already exist. */
  resources: string[];
}

export const CATALOG: SuggestionEntry[] = [
  {
    id: "tickets",
    label: "Set up ticket management?",
    prompt: "Help me set up ticket management.",
    resources: ["tickets"],
  },
  {
    id: "leads",
    label: "Track sales leads?",
    prompt: "Help me track sales leads.",
    resources: ["leads"],
  },
  {
    id: "employees",
    label: "Manage employees?",
    prompt: "Help me set up employee management.",
    resources: ["employees"],
  },
  {
    id: "invoices",
    label: "Track invoices & billing?",
    prompt: "Help me set up invoices and billing.",
    resources: ["invoices"],
  },
  {
    id: "inventory",
    label: "Manage inventory?",
    prompt: "Help me set up inventory tracking.",
    resources: ["inventory"],
  },
  {
    id: "projects",
    label: "Organize projects & tasks?",
    prompt: "Help me organize projects and tasks.",
    resources: ["projects"],
  },
];
