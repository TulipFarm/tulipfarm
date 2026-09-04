import { useEffect, useRef, useState } from "react";
import { Sheet } from "~/components/ui/sheet";
import { useCompanion } from "~/lib/companion-context";
import { CompanionPanel } from "./companion-panel";

/* The brand mark (public/logo-*.png) shares the growth illustration's three-petal face but is
   tuned to read at small/app-icon sizes — the growth SVG carries soil, stem and leaves too, so
   cropping its bloom down to avatar size collapses it into an unreadable blob. So the collapsed
   trigger uses the brand mark, not `TulipGrowth`. */
const AVATAR_SRC = "/logo-128.png";

/**
 * The persistent onboarding Companion (`sm`+ only — see `CompanionMobileTrigger` for the
 * collapsed top-bar icon below `sm`). Never auto-opens; a pending Task only adds a dot badge
 * and a gentle breathe, never a popup.
 */
export function OnboardingCompanion() {
  const { tasks, loading, open, setOpen, refresh, dismiss } = useCompanion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, setOpen]);

  if (!loading && tasks.length === 0 && !open) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 hidden sm:block">
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Onboarding companion"
          className="absolute bottom-14 right-0 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
        >
          <CompanionPanel
            tasks={tasks}
            loading={loading}
            onDismiss={dismiss}
            onAnswered={refresh}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        aria-label={
          tasks.length > 0
            ? `Onboarding companion, ${tasks.length} suggestion`
            : "Onboarding companion"
        }
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="relative flex size-12 items-center justify-center rounded-full border border-border bg-card shadow-md transition hover:border-primary/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
      >
        <img src={AVATAR_SRC} alt="" width={32} height={32} className="size-8" />
        {tasks.length > 0 ? (
          <span
            aria-hidden
            className="companion-badge-pulse absolute right-0.5 top-0.5 size-2.5 rounded-full bg-primary"
          />
        ) : null}
      </button>
    </div>
  );
}

/**
 * Below `sm`, the Companion collapses into a top-bar icon (mounted in `app-sidebar.tsx`'s
 * header) instead of floating, so it never overlaps the chat composer. Panel reuses `Sheet`.
 */
export function CompanionMobileTrigger() {
  const { tasks, loading, open, setOpen, refresh, dismiss } = useCompanion();
  // Native <dialog> promotes to the top layer on showModal() regardless of an ancestor's
  // `sm:hidden`, so its full-viewport ::backdrop would swallow clicks on the desktop floating
  // panel below unless the <Sheet> itself is kept unmounted outside its own breakpoint.
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (!loading && tasks.length === 0 && !open) return null;

  return (
    <>
      <button
        type="button"
        aria-label={
          tasks.length > 0
            ? `Onboarding companion, ${tasks.length} suggestion`
            : "Onboarding companion"
        }
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="relative flex size-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
      >
        <img src={AVATAR_SRC} alt="" width={22} height={22} className="size-[22px]" />
        {tasks.length > 0 ? (
          <span
            aria-hidden
            className="companion-badge-pulse absolute right-1 top-1.5 size-2.5 rounded-full bg-primary"
          />
        ) : null}
      </button>
      {isMobile ? (
        <Sheet open={open} onClose={() => setOpen(false)} title="Onboarding companion">
          <CompanionPanel
            tasks={tasks}
            loading={loading}
            onDismiss={dismiss}
            onAnswered={refresh}
            onClose={() => setOpen(false)}
          />
        </Sheet>
      ) : null}
    </>
  );
}
