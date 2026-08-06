import {
  BookOpen,
  Code2,
  FileText,
  Layers,
  type LucideIcon,
  Palette,
  Sliders,
  Sparkles,
} from "lucide-react";

export type FollowupPillItem = {
  id: string;
  label: string;
  prompt: string;
  iconName?: string;
};

export type FollowupPillsProps = {
  items: FollowupPillItem[];
  onPick: (prompt: string) => void;
  disabled?: boolean;
};

const ICON_MAP: Record<string, LucideIcon> = {
  palette: Palette,
  layers: Layers,
  code: Code2,
  book: BookOpen,
  file: FileText,
  sliders: Sliders,
  sparkles: Sparkles,
};

/**
 * Followup Pills: Displays interactive suggestion chips that draft prompts into the composer (matches Screenshot 2 design).
 */
export function FollowupPills({ items, onPick, disabled }: FollowupPillsProps) {
  if (!items || items.length === 0) return null;

  return (
    <div className="my-3 flex flex-wrap gap-2">
      {items.map((item) => {
        const IconComponent = (item.iconName && ICON_MAP[item.iconName]) || Sparkles;

        return (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(item.prompt)}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-xs transition-all hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
          >
            <IconComponent className="size-3.5 text-primary shrink-0" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
