import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelTier } from "~/lib/chat/types";
import { getLlmConfig } from "~/lib/settings";
import { cn } from "~/lib/utils";

type Tier = "quick" | "standard" | "complex";

// The three pickable tiers, in ascending capability/intensity. `level` drives the signal-bar icon;
// `blurb` explains what the tier means. (`auto` exists in the backend selector but isn't offered here.)
const TIERS: { id: Tier; label: string; level: 1 | 2 | 3; blurb: string }[] = [
  { id: "quick", label: "quick", level: 1, blurb: "Fast & low-cost — short answers, simple tasks" },
  { id: "standard", label: "standard", level: 2, blurb: "Balanced default for everyday chat" },
  { id: "complex", label: "complex", level: 3, blurb: "Deepest reasoning — hard, multi-step work" },
];

// Three ascending bars, like a volume/signal meter: bars up to `level` are lit, the rest dimmed.
function SignalBars({ level }: { level: 1 | 2 | 3 }) {
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

/**
 * Per-message model override (maps 1:1 to the POST /chat `model` field). A dropdown over the three
 * tiers: the trigger shows the active tier with a signal-bar intensity icon, and each menu option
 * explains what the tier means (line 1) and lists the models configured for it (line 2, read once
 * from GET /api/v1/llm-config). The menu is portalled so the composer's clipping box never crops it.
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
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<Record<Tier, string[]>>({
    quick: [],
    standard: [],
    complex: [],
  });
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getLlmConfig()
      .then((cfg) => {
        if (!alive) return;
        const list = (t: Tier) =>
          (cfg.tiers?.[t]?.providers ?? []).map((p) => `${p.provider} / ${p.model}`);
        setModels({ quick: list("quick"), standard: list("standard"), complex: list("complex") });
      })
      // Non-admins or an unconfigured instance: the models line falls back to "not configured".
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Close on outside click, Escape, or any scroll/resize (the menu is fixed-positioned off the rect).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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

  const current = TIERS.find((t) => t.id === value) ?? TIERS[1];

  function toggle() {
    if (!open && triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="select-none uppercase tracking-[0.15em]">
        model
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${current.label}`}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border border-input bg-secondary px-1.5 py-1 text-foreground transition-colors",
          "outline-none focus-visible:border-primary disabled:opacity-50 hover:border-primary/60"
        )}
      >
        <SignalBars level={current.level} />
        <span>{current.label}</span>
        <ChevronDown aria-hidden className="size-3 opacity-70" />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-50 w-72 rounded-sm border border-border bg-card p-1 text-xs"
              style={{ left: rect.left, bottom: window.innerHeight - rect.top + 6 }}
            >
              {TIERS.map((t) => {
                const active = value === t.id;
                const tierModels = models[t.id];
                const modelLine = tierModels.length > 0 ? tierModels.join(", ") : "not configured";
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={t.label}
                    aria-pressed={active}
                    onClick={() => {
                      onChange(t.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-secondary",
                      active && "bg-secondary"
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-foreground">
                      <SignalBars level={t.level} />
                      <span className="font-medium">{t.label}</span>
                      {active ? (
                        <Check aria-hidden className="ml-auto size-3.5 text-primary" />
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">{t.blurb}</span>
                    <span className="break-words text-[0.6875rem] text-muted-foreground/70">
                      {modelLine}
                    </span>
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
