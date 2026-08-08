import { asEffortPreset } from "@tulipfarm/schema";
import { Check, ChevronDown } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatModelSelector } from "~/lib/chat/types";
import { cn } from "~/lib/utils";

export const DEFAULT_CHAT_MODEL_SELECTOR: ChatModelSelector = "auto";

type PresetOption = {
  id: ChatModelSelector;
  label: string;
  level: 0 | 1 | 2 | 3;
  description: string;
  default?: boolean;
};

const AUTO_OPTION: PresetOption = {
  id: "auto",
  label: "Auto",
  level: 0,
  description: "Lets TulipFarm balance effort, latency, and cost for this turn.",
  default: true,
};

const PRESET_OPTIONS: readonly PresetOption[] = [
  AUTO_OPTION,
  {
    id: "fast",
    label: "Fast",
    level: 1,
    description: "Lower effort for faster, lower-cost replies.",
  },
  {
    id: "balanced",
    label: "Balanced",
    level: 2,
    description: "Moderate effort for everyday depth, latency, and cost.",
  },
  {
    id: "thorough",
    label: "Thorough",
    level: 3,
    description: "Higher effort for deeper work with more latency and cost.",
  },
];

const PICKABLE_PRESETS = PRESET_OPTIONS.map((option) => option.id);

export function asPickerPreset(s: string | undefined): ChatModelSelector | undefined {
  const preset = asEffortPreset(s);
  return preset != null && (PICKABLE_PRESETS as readonly string[]).includes(preset)
    ? preset
    : undefined;
}

export function effectiveEffortPreset(args: {
  mentionedAgentId?: string;
  presetById: (id: string) => ChatModelSelector | undefined;
  activeAgentPreset?: ChatModelSelector;
  fallback: ChatModelSelector;
}): ChatModelSelector {
  const mentioned = args.mentionedAgentId ? args.presetById(args.mentionedAgentId) : undefined;
  return mentioned ?? args.activeAgentPreset ?? args.fallback;
}

function optionFor(value: ChatModelSelector): PresetOption {
  return PRESET_OPTIONS.find((option) => option.id === value) ?? AUTO_OPTION;
}

function optionIndex(value: ChatModelSelector): number {
  const index = PRESET_OPTIONS.findIndex((option) => option.id === value);
  return index >= 0 ? index : 0;
}

function SignalBars({ level }: { level: 0 | 1 | 2 | 3 }) {
  const bars = [3, 6, 9];
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" className="shrink-0">
      {bars.map((h, i) => (
        <rect
          key={h}
          x={0.5 + i * 4}
          y={10 - h}
          width="2.5"
          height={h}
          rx="0.5"
          className={cn("fill-current", i < level ? "opacity-100" : "opacity-25")}
        />
      ))}
    </svg>
  );
}

export function ModelSelector({
  value,
  onChange,
  disabled,
}: {
  value: ChatModelSelector;
  onChange: (preset: ChatModelSelector) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(() => optionIndex(value));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = optionFor(value);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[focusedIndex]?.focus();
  }, [focusedIndex, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function openMenu(nextIndex = optionIndex(value)) {
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setFocusedIndex(nextIndex);
    setOpen(true);
  }

  function toggle() {
    if (open) {
      setOpen(false);
    } else {
      openMenu();
    }
  }

  function choose(option: PresetOption) {
    onChange(option.id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveFocus(delta: number) {
    setFocusedIndex((index) => (index + delta + PRESET_OPTIONS.length) % PRESET_OPTIONS.length);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(optionIndex(value));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(PRESET_OPTIONS.length - 1);
    }
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFocusedIndex(PRESET_OPTIONS.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(PRESET_OPTIONS[focusedIndex] ?? AUTO_OPTION);
    }
  }

  return (
    <div className="flex items-center text-xs text-muted-foreground">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Effort preset: ${current.label}${current.default ? " (default)" : ""}`}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 font-medium text-foreground transition",
          "outline-none hover:border-primary/60 active:translate-y-px focus-visible:border-primary disabled:opacity-50"
        )}
      >
        <SignalBars level={current.level} />
        <span>{current.label}</span>
        {current.default ? (
          <span className="rounded-sm bg-secondary px-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
            Default
          </span>
        ) : null}
        <ChevronDown aria-hidden className="size-3 opacity-70" />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Effort preset"
              className="fixed z-50 w-72 rounded-sm border border-border bg-card p-1 text-xs"
              style={{ left: rect.left, bottom: window.innerHeight - rect.top + 6 }}
              onKeyDown={onMenuKeyDown}
            >
              {PRESET_OPTIONS.map((option, index) => {
                const active = value === option.id;
                return (
                  <button
                    key={option.id}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onFocus={() => setFocusedIndex(index)}
                    onClick={() => choose(option)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-sm px-2 py-2 text-left transition hover:bg-secondary active:translate-y-px",
                      active && "bg-secondary"
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-foreground">
                      <SignalBars level={option.level} />
                      <span className="font-medium">{option.label}</span>
                      {option.default ? (
                        <span className="rounded-sm bg-background px-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                          Default
                        </span>
                      ) : null}
                      {active ? (
                        <Check aria-hidden className="ml-auto size-3.5 text-primary" />
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">{option.description}</span>
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
