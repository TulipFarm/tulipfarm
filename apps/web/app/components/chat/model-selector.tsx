import type { ModelTier } from "~/lib/chat/types";
import { cn } from "~/lib/utils";

const TIERS: ModelTier[] = ["standard", "complex"];

/**
 * Per-message model override. Maps 1:1 to the POST /chat `model` field. The default is the active
 * agent's tier (e.g. GeneralAssistant → standard); the user can switch between the two surfaced
 * tiers. (`auto`/`quick` exist in the backend selection but are not offered here.)
 */
export function ModelSelector({
  value,
  onChange,
  disabled,
}: {
  value: ModelTier;
  onChange: (model: ModelTier) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="select-none uppercase tracking-[0.15em]">
        model
      </span>
      <select
        aria-label="Model"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ModelTier)}
        className={cn(
          "rounded-sm border border-input bg-secondary px-1.5 py-1 text-foreground",
          "outline-none focus-visible:border-primary disabled:opacity-50"
        )}
      >
        {TIERS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
