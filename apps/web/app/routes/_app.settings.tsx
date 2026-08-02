import { type MetaFunction, Outlet, useLocation } from "@remix-run/react";
import { Activity, Brain, Cpu, History, KeyRound, type LucideIcon, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { getUpdateCheck, type UpdateCheck } from "~/lib/system";
import { cn } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Settings · tulipfarm" }];

type Section = {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
  // Dashboard/explorer surfaces fill the full main width; form-style sections stay constrained.
  wide?: boolean;
};

// Single source of truth for both the secondary sidebar nav and the per-section header.
const sections: Section[] = [
  {
    to: "/settings/secrets",
    label: "Secrets",
    icon: KeyRound,
    description: "Provider credentials and custom secrets. Values are never shown.",
  },
  {
    to: "/settings/llm",
    label: "LLM",
    icon: Cpu,
    description: "Model tiers and provider routing. Tiers run as a fallback chain, top first.",
  },
  {
    to: "/settings/observability",
    label: "Observability",
    icon: Activity,
    description: "What your agents are spending and doing — cost, tokens, and reliability.",
    wide: true,
  },
  {
    to: "/settings/soul",
    label: "Soul",
    icon: Sparkles,
    description: "Browse the version-controlled soul repository.",
    wide: true,
  },
  {
    to: "/settings/activities",
    label: "Activities",
    icon: History,
    description: "Everything that happens in this workspace — records, chats, jobs, and more.",
    wide: true,
  },
  {
    to: "/settings/memory",
    label: "Memory",
    icon: Brain,
    description: "What the assistant remembers about you — saved facts and preferences.",
    wide: true,
  },
];

/*
 * Settings shell (Knowledge-style). A persistent section rail on the left, the selected section in
 * the content outlet on the right — the rail stays put while sections swap. The main app sidebar
 * auto-collapses to its icon rail under /settings (wired in _app.tsx via `forceCollapsed`), giving
 * this rail the freed space. On mobile the rail stacks above the content. Children own their data.
 */
function UpdateNotice() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  useEffect(() => {
    getUpdateCheck()
      .then(setCheck)
      .catch(() => setCheck(null)); // advisory only — never surface an error for this
  }, []);
  if (!check?.updateAvailable || !check.latest) return null;
  return (
    <div className="mb-4 flex items-center gap-2 rounded-sm border border-border bg-muted px-3 py-2 text-sm">
      <span className="text-foreground">
        TulipFarm v{check.latest} is available (running v{check.version}).
      </span>
      <a
        href="https://github.com/tulipfarm/tulipfarm/releases"
        target="_blank"
        rel="noreferrer"
        className="text-primary underline-offset-2 hover:underline"
      >
        Release notes
      </a>
      <span className="text-muted-foreground">— see the README's update runbook to apply.</span>
    </div>
  );
}

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const active = sections.find((s) => pathname.startsWith(s.to)) ?? sections[0];
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className={cn("w-full px-6 py-8 md:px-8", !active.wide && "max-w-4xl")}>
          <UpdateNotice />
          <header className="mb-6">
            <p className="text-xs font-medium text-muted-foreground">Settings</p>
            <h1 className="mt-2 text-xl font-semibold text-foreground">{active.label}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{active.description}</p>
          </header>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
