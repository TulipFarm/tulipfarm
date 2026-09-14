import type { OnboardingSuggestion } from "./schema";

export const ONBOARDING_FALLBACK: OnboardingSuggestion[] = [
  {
    id: "agent",
    label: "Create an agent?",
    prompt: "Help me create a custom agent.",
  },
  {
    id: "knowledge",
    label: "Add knowledge?",
    prompt: "Help me add knowledge.",
  },
  {
    id: "integration",
    label: "Connect an integration?",
    prompt: "Help me connect an integration.",
  },
  {
    id: "team",
    label: "Invite team members?",
    prompt: "Help me invite team members.",
  },
];
