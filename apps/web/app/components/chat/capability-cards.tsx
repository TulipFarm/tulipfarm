import type { Icon } from "~/components/icons";
import {
  BookOpen,
  Database,
  File,
  FileText,
  Flag,
  Globe,
  Library,
  MessageCircle,
  Plug,
  Waypoints,
} from "~/components/icons";

type CapabilityCard = {
  id: string;
  label: string;
  icon: Icon;
  /** Drafted into the composer verbatim, cursor left at the end for the reader to finish it. */
  prompt: string;
};

type CapabilityGroup = {
  label: string;
  cards: CapabilityCard[];
};

const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    label: "Create",
    cards: [
      { id: "create-task", label: "Tasks", icon: Flag, prompt: "Create a task to " },
      {
        id: "create-routine",
        label: "Routines",
        icon: Waypoints,
        prompt: "Set up a routine that ",
      },
      {
        id: "create-resource",
        label: "Resources",
        icon: Database,
        prompt: "Define a resource type for ",
      },
      { id: "create-doc", label: "Docs", icon: FileText, prompt: "Draft a doc about " },
    ],
  },
  {
    label: "Find",
    cards: [
      { id: "find-answer", label: "Answers", icon: MessageCircle, prompt: "What is " },
      { id: "find-record", label: "Records", icon: Library, prompt: "Find records where " },
      { id: "find-file", label: "Files", icon: File, prompt: "Find files about " },
    ],
  },
  {
    label: "Research",
    cards: [
      { id: "research-web", label: "Web", icon: Globe, prompt: "Research on the web about " },
      {
        id: "research-integration",
        label: "Integrations",
        icon: Plug,
        prompt: "Look into connecting ",
      },
      {
        id: "research-knowledge",
        label: "Knowledge",
        icon: BookOpen,
        prompt: "Search our knowledge for ",
      },
    ],
  },
];

/**
 * Capability-discovery cards on the empty Chat landing screen: each fills the composer with a
 * template prompt for that action and focuses it, rather than sending anything or opening a wizard.
 */
export function CapabilityCards({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mt-6 w-full">
      <div className="flex flex-col gap-4">
        {CAPABILITY_GROUPS.map((group) => (
          <fieldset key={group.label} className="flex flex-col gap-1.5">
            <legend className="px-0.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </legend>
            <div className="flex flex-wrap gap-2">
              {group.cards.map((card) => {
                const CardIcon = card.icon;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => onPick(card.prompt)}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground transition hover:border-primary/60 hover:bg-accent active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25"
                  >
                    <CardIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    {card.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
