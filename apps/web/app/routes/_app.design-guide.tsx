import type { MetaFunction } from "@remix-run/react";
import { Check, Copy, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Composer } from "~/components/chat/composer";
import { Transcript } from "~/components/chat/transcript";
import { PriorityBadge, StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Textarea } from "~/components/ui/textarea";
import type { ChatMessage } from "~/lib/chat/types";

export const meta: MetaFunction = () => [{ title: "Design guide · tulipfarm" }];

export function clientLoader() {
  if (!import.meta.env.DEV) throw new Response("Not found", { status: 404 });
  return null;
}

/**
 * A finished reply carrying a receipt. Auto is a request, not an outcome, so the receipt names the
 * rung it resolved to — which is also what "Try harder" escalates from.
 */
const TRANSCRIPT_MESSAGES: ChatMessage[] = [
  {
    id: "guide-user",
    role: "user",
    sealed: true,
    parts: [{ kind: "text", text: "Which invoices are overdue?" }],
  },
  {
    id: "guide-assistant",
    role: "assistant",
    sealed: true,
    parts: [{ kind: "text", text: "Three invoices are overdue by more than 30 days." }],
    receipt: {
      modelId: "claude-sonnet-5",
      effortPreset: "auto",
      effortApplied: "balanced",
      modelCallLatencyMs: 1240,
    },
    sourceTurn: { text: "Which invoices are overdue?", options: { model: "auto" } },
  },
];

const TOKENS = [
  ["Background", "bg-background"],
  ["Card", "bg-card"],
  ["Secondary", "bg-secondary"],
  ["Muted", "bg-muted"],
  ["Accent", "bg-accent"],
  ["Primary", "bg-primary"],
  ["Destructive", "bg-destructive"],
] as const;

const GUIDE_LINKS = [
  ["principles", "Design principles"],
  ["stack", "Tech stack"],
  ["tokens", "Design tokens"],
  ["typography", "Typography scale"],
  ["status-priority", "Status & priority systems"],
  ["hierarchy", "Component hierarchy"],
  ["composition", "Composition patterns"],
  ["actions", "Interactive patterns"],
  ["layout", "Layout system"],
  ["guide-page", "The /design-guide page"],
  ["forms", "Component index"],
  ["files", "File conventions"],
  ["mistakes", "Common mistakes to avoid"],
] as const;

function GuideSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 border-b border-border py-8"
    >
      <div className="mb-5 max-w-2xl">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export default function DesignGuideRoute() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
      <header className="max-w-3xl pb-6">
        <Badge variant="primary">Internal reference</Badge>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">TulipFarm design guide</h1>
        <p className="mt-2 text-base text-muted-foreground">
          The live showcase for tokens, typography, reusable components, and composition patterns.
        </p>
      </header>

      <nav
        aria-label="Design guide sections"
        className="grid gap-1 rounded-md border border-border p-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {GUIDE_LINKS.map(([id, label], index) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="mr-2 font-mono text-xs text-primary">{index + 1}.</span>
            {label}
          </a>
        ))}
      </nav>

      <GuideSection
        id="principles"
        title="Design principles"
        description="Work-surface first, neutral by default, reusable at the correct layer, and accessible in every state."
      >
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          {[
            "Use one clear primary action per view.",
            "Build hierarchy with type, spacing, and structure.",
            "Reserve coral for brand, selection, focus, and primary action.",
            "Treat keyboard, contrast, motion, and long content as component states.",
          ].map((item) => (
            <li key={item} className="rounded-md border border-border bg-card px-4 py-3">
              {item}
            </li>
          ))}
        </ul>
      </GuideSection>

      <GuideSection
        id="stack"
        title="Tech stack"
        description="Remix SPA, React 19, TypeScript, Tailwind v4, CVA, Lucide, and app-local shadcn-style primitives."
      >
        <p className="max-w-3xl font-mono text-sm text-muted-foreground">
          Remix · React · TypeScript · Tailwind CSS · Vitest · Testing Library
        </p>
      </GuideSection>

      <GuideSection
        id="tokens"
        title="Design tokens"
        description="Semantic surfaces adapt to the active light or dark theme."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-16 ${color}`} />
              <div className="border-t border-border bg-background px-3 py-2 text-sm">{label}</div>
            </div>
          ))}
        </div>
      </GuideSection>

      <GuideSection
        id="typography"
        title="Typography scale"
        description="Inter carries product UI while JetBrains Mono identifies technical content."
      >
        <div className="space-y-3">
          <p className="text-3xl font-semibold">Display · 32/40</p>
          <p className="text-2xl font-semibold">Heading · 24/32</p>
          <p className="text-xl font-semibold">Title · 20/28</p>
          <p className="text-base">Body · 16/24 — readable product content and instructions.</p>
          <p className="text-sm font-medium">Label · 14/20</p>
          <p className="font-mono text-xs text-muted-foreground">
            run_01J8M7Q2 · 2026-08-02T10:30Z
          </p>
        </div>
      </GuideSection>

      <GuideSection
        id="actions"
        title="Interactive patterns"
        description="One primary action per view, with secondary and dangerous actions subordinate."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary action</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button disabled>Disabled</Button>
          <Button size="icon" aria-label="Copy example">
            <Copy aria-hidden />
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge>Neutral</Badge>
          <Badge variant="info">Information</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="danger">Danger</Badge>
          <Badge variant="primary">Primary</Badge>
        </div>
      </GuideSection>

      <GuideSection
        id="status-priority"
        title="Status & priority systems"
        description="Lifecycle and urgency use separate closed semantic systems."
      >
        <div className="flex flex-wrap gap-2">
          <StatusBadge label="Draft" />
          <StatusBadge label="Running" tone="info" />
          <StatusBadge label="Succeeded" tone="success" />
          <StatusBadge label="Needs attention" tone="warning" />
          <StatusBadge label="Failed" tone="danger" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <PriorityBadge priority="low" />
          <PriorityBadge priority="medium" />
          <PriorityBadge priority="high" />
          <PriorityBadge priority="critical" />
        </div>
      </GuideSection>

      <GuideSection
        id="hierarchy"
        title="Component hierarchy"
        description="Foundations feed primitives, primitives compose into reusable patterns, and features own domain behavior."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["1", "Foundations", "Tokens, type, spacing, radius, motion"],
            ["2", "Primitives", "Buttons, fields, badges, overlays"],
            ["3", "Composites", "Shell, panels, forms, feedback"],
            ["4", "Features", "Domain data, behavior, and orchestration"],
          ].map(([step, title, detail]) => (
            <article key={step} className="rounded-md border border-border bg-card p-4">
              <span className="font-mono text-xs text-primary">{step}</span>
              <h3 className="mt-2 text-sm font-semibold">{title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
            </article>
          ))}
        </div>
      </GuideSection>

      <GuideSection
        id="forms"
        title="Component index"
        description="Visible labels and local help remain part of every field contract."
      >
        <form
          className="grid max-w-2xl gap-5 sm:grid-cols-2"
          onSubmit={(event) => event.preventDefault()}
        >
          <label htmlFor="guide-name" className="grid gap-1.5 text-sm font-medium">
            Name
            <Input id="guide-name" placeholder="Quarterly planning" />
          </label>
          <label htmlFor="guide-status" className="grid gap-1.5 text-sm font-medium">
            Status
            <Select id="guide-status" defaultValue="draft">
              <option value="draft">Draft</option>
              <option value="active">Active</option>
            </Select>
          </label>
          <label
            htmlFor="guide-description"
            className="grid gap-1.5 text-sm font-medium sm:col-span-2"
          >
            Description
            <Textarea
              id="guide-description"
              placeholder="Describe the purpose and expected outcome."
            />
            <span className="text-xs font-normal text-muted-foreground">
              Keep it concise and actionable.
            </span>
          </label>
        </form>
      </GuideSection>

      <GuideSection
        id="composition"
        title="Composition patterns"
        description="Panels, navigation, and feedback use the same spacing and hierarchy."
      >
        <div className="mb-6 overflow-hidden rounded-md border border-border bg-background px-4 py-4">
          <Transcript
            messages={TRANSCRIPT_MESSAGES}
            status="idle"
            onApprove={() => undefined}
            onTryHarder={() => undefined}
          />
        </div>
        <div className="mb-6 overflow-hidden rounded-md border border-border bg-background">
          <Composer
            onSend={() => undefined}
            activeAgent={{ name: "InventoryPlanner", label: "Inventory planner" }}
            suggestions={[
              {
                id: "clarify",
                label: "Clarify the problem",
                prompt: "Help me clarify the problem before we start.",
              },
              {
                id: "plan",
                label: "Create a plan",
                prompt: "Create a practical plan with clear next steps.",
              },
            ]}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <article className="rounded-md border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <h3 className="text-sm font-semibold">Search results</h3>
            </header>
            <div className="px-4 py-5 text-sm text-muted-foreground">No matching Records yet.</div>
          </article>
          <article className="rounded-md border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Check className="size-4 text-status-success" aria-hidden />
              <h3 className="text-sm font-semibold">Ready</h3>
            </header>
            <div className="px-4 py-5 text-sm text-muted-foreground">
              All systems are available.
            </div>
          </article>
          <article className="rounded-md border border-border bg-card">
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Settings className="size-4 text-muted-foreground" aria-hidden />
              <h3 className="text-sm font-semibold">Configuration</h3>
            </header>
            <div className="px-4 py-5 text-sm text-muted-foreground">
              Changes apply after validation.
            </div>
          </article>
        </div>
      </GuideSection>

      <GuideSection
        id="layout"
        title="Layout system"
        description="A 56px product rail, 256px context panel, and 52px top bar adapt at 768px and 1024px. All three columns share the same 52px header row."
      >
        <div className="flex h-32 overflow-hidden rounded-md border border-border text-xs">
          <div className="flex w-14 shrink-0 flex-col border-r border-border bg-background">
            <div className="flex h-[52px] items-center justify-center border-b border-border font-mono">
              56
            </div>
            <div className="flex-1" />
          </div>
          <div className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
            <div className="flex h-[52px] items-center border-b border-border px-4 font-mono">
              256
            </div>
            <div className="flex-1" />
          </div>
          <div className="min-w-0 flex-1 bg-card">
            <div className="flex h-[52px] items-center border-b border-border px-4 font-mono">
              52
            </div>
            <div className="p-4 text-muted-foreground">Work surface</div>
          </div>
        </div>
      </GuideSection>

      <GuideSection
        id="guide-page"
        title="The /design-guide page"
        description="This development-only route renders production components and must change with their public vocabulary."
      >
        <StatusBadge label="Development only" tone="info" />
      </GuideSection>

      <GuideSection
        id="files"
        title="File conventions"
        description="Use app-local primitives, named exports, kebab-case files, type-only imports, CVA variants, and colocated tests."
      >
        <code className="block max-w-3xl rounded-md border border-border bg-muted p-4 font-mono text-sm">
          apps/web/app/components/ui/component.tsx
        </code>
      </GuideSection>

      <GuideSection
        id="mistakes"
        title="Common mistakes to avoid"
        description="Do not introduce raw colors, duplicated controls, all-monospace prose, color-only feedback, tiny targets, or decorative effects."
      >
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search for an existing token or component first. If the public vocabulary changes, update
          this page and the repository skill in the same change.
        </p>
      </GuideSection>

      <Separator />
      <p className="py-6 font-mono text-xs text-muted-foreground">
        Update this page whenever the public component vocabulary changes.
      </p>
    </div>
  );
}
