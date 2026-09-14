import type { ConversationMode } from "@tulipfarm/schema";
import { X } from "~/components/icons";
import { MODE_CONFIGS } from "./mode-config";

export function ModeBanner({
  mode,
  onClose,
}: {
  mode: ConversationMode | null;
  onClose: () => void;
}) {
  if (!mode || !(mode in MODE_CONFIGS)) return null;
  const details = MODE_CONFIGS[mode];
  const Icon = details.icon;

  return (
    <div
      role="status"
      className="flex min-h-6 shrink-0 items-center gap-1.5 border-b px-4 text-xs sm:px-6"
      style={{
        backgroundColor: `color-mix(in srgb, ${details.colorVar} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${details.colorVar} 30%, transparent)`,
        color: details.colorVar,
      }}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="font-medium">{details.label}</span>
      <span className="opacity-80">·</span>
      <span className="opacity-80">{details.description}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Exit mode"
        className="ml-auto inline-flex size-5 items-center justify-center rounded-sm transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
