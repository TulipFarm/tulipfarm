import { Link, type MetaFunction } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Guided first steps surfaced on the welcome screen (AC-V1-001). Non-blocking.
const steps: { label: string; hint: string; to?: string }[] = [
  { label: "Connect a soul", hint: "point the instance at your config repo", to: "/integrations" },
  { label: "Ask the assistant", hint: 'try "what can you do?"' },
  { label: "Explore resources", hint: "browse schema-driven records", to: "/resources" },
  { label: "Review approvals", hint: "gate what your agents do", to: "/approvals" },
];

function Step({ label, hint, to }: { label: string; hint: string; to?: string }) {
  const body = (
    <>
      <span aria-hidden className="text-primary">
        [+]
      </span>
      <span className="font-medium text-foreground">{label}</span>
      <span className="flex-1 text-muted-foreground">{hint}</span>
      {to ? (
        <span
          aria-hidden
          className="text-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        >
          →
        </span>
      ) : null}
    </>
  );
  return to ? (
    <Link
      to={to}
      className="group flex items-baseline gap-2 rounded-sm border border-transparent px-3 py-2 transition-colors duration-150 hover:border-border hover:bg-accent"
    >
      {body}
    </Link>
  ) : (
    <span className="flex items-baseline gap-2 px-3 py-2">{body}</span>
  );
}

// Default view on session start (AC-V1-001): chat welcome + guided first steps.
export default function ChatWelcome() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          <span aria-hidden className="animate-cursor text-primary">
            ▍
          </span>
          tulipfarm
        </h1>
        <p className="text-muted-foreground">
          The business agent harness. Ask anything, or pick a first step below.
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <span>ready</span>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span>GeneralAssistant</span>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span>8 sections</span>
        </p>
      </div>

      {/* Placeholder prompt row — chat input is wired in a downstream ticket, so it is intentionally
          non-interactive (flagged "soon") rather than a dead-looking text field. */}
      <div
        title="Chat wiring lands in a later ticket"
        className="flex cursor-not-allowed select-none items-center gap-3 rounded-sm border border-input bg-secondary px-3 py-3 text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 [animation-delay:120ms] [animation-fill-mode:both]"
      >
        <span aria-hidden className="text-primary">
          |
        </span>
        <span className="flex-1">Ask anything…</span>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.15em]">
          soon
        </span>
        <span className="rounded-sm border border-border px-2 py-0.5 text-xs">
          GeneralAssistant
        </span>
      </div>

      <div className="flex flex-col gap-1 text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 [animation-delay:240ms] [animation-fill-mode:both]">
        <p className="px-3 pb-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          First steps
        </p>
        {steps.map((s) => (
          <Step key={s.label} label={s.label} hint={s.hint} to={s.to} />
        ))}
      </div>
    </div>
  );
}
