import type { ConversationMode } from "@tulipfarm/schema";
import { cn } from "~/lib/utils";
import { CONVERSATION_MODES_LIST } from "./mode-config";

export function ModeSelector({
  value,
  onChange,
}: {
  value: ConversationMode | null;
  onChange: (mode: ConversationMode | null) => void;
}) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1.5">
      {CONVERSATION_MODES_LIST.map((mode) => {
        const active = value === mode.id;
        const Icon = mode.icon;
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange(active ? null : mode.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25",
              active
                ? "border-transparent text-background"
                : "border-input bg-background text-foreground hover:bg-accent"
            )}
            style={active ? { backgroundColor: mode.colorVar } : undefined}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
