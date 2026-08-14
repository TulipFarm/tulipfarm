import type { MetaFunction } from "@remix-run/react";
import { Check, Copy, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Composer } from "~/components/chat/composer";
import { MessagePartView } from "~/components/chat/parts";
import { ToolRun } from "~/components/chat/tool-call";
import { Transcript } from "~/components/chat/transcript";
import { FormStatus } from "~/components/form-status";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { CompanionPanel } from "~/components/onboarding/companion-panel";
import { TulipGrowth, type TulipStage } from "~/components/onboarding/tulip-growth";
import { PriorityBadge, StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty, PanelRow } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Textarea } from "~/components/ui/textarea";
import type { ChatMessage, PlanStep, TimelinePart } from "~/lib/chat/types";

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

/**
 * A Run that failed and a Record marked "blocked" are unrelated facts, so they never share a
 * tone.
 */
const RUN_TOKENS = [
  ["run-pending", "bg-run-pending"],
  ["run-active", "bg-run-active"],
  ["run-ok", "bg-run-ok"],
  ["run-error", "bg-run-error"],
  ["run-blocked", "bg-run-blocked"],
  ["run-skipped", "bg-run-skipped"],
] as const;

/** Categorical encoding for charts and series. Never chrome, never status, never brand. */
const DATA_TOKENS = [
  ["data-1", "bg-data-1"],
  ["data-2", "bg-data-2"],
  ["data-3", "bg-data-3"],
  ["data-4", "bg-data-4"],
  ["data-5", "bg-data-5"],
  ["data-6", "bg-data-6"],
  ["data-7", "bg-data-7"],
  ["data-8", "bg-data-8"],
] as const;

/** Which layer a Tool belongs to. Tints the glyph so a system call never reads as an outbound one. */
const TIER_TOKENS = [
  ["system", "bg-tool-tier-system"],
  ["platform", "bg-tool-tier-platform"],
  ["integration", "bg-tool-tier-integration"],
  ["mutating", "bg-tool-mutating"],
] as const;

const TULIP_STAGES: readonly TulipStage[] = [0, 1, 2, 3];

/** Static specimen quests — one per tier — for the Companion panel showcase. Never wired live. */
const GUIDE_QUESTS = [
  {
    id: "provider-key",
    tier: 1 as const,
    label: "Plant your model key",
    hint: "Agents need one provider connected before they can do anything.",
    action: { kind: "link" as const, href: "/settings/secrets" },
  },
  {
    id: "checklist-resource",
    tier: 2 as const,
    label: "Create your first resource type",
    action: { kind: "chat" as const, prompt: "Help me create a resource type." },
  },
  {
    id: "profile-employee-count",
    tier: 3 as const,
    label: "How many people work here?",
    action: {
      kind: "chat" as const,
      prompt: "Help me record how many employees the business has.",
    },
  },
];

const TOOL_SPECIMENS: { caption: string; part: Extract<TimelinePart, { kind: "tool" }> }[] = [
  {
    caption: "Running",
    part: {
      kind: "tool",
      toolCallId: "call_01J8M7Q2AA",
      toolName: "search_docs",
      args: { argsDigest: "sha256:9f1c" },
      status: "running",
      argsPreview: { json: JSON.stringify({ query: "pgvector migration", limit: 5 }) },
      meta: { tier: "platform", stepId: "state-1" },
    },
  },
  {
    caption: "Succeeded, with a redacted argument",
    part: {
      kind: "tool",
      toolCallId: "call_01J8M7Q2BB",
      toolName: "github_issue_comment",
      args: { argsDigest: "sha256:4b7e" },
      status: "done",
      outcome: "ok",
      argsPreview: {
        json: JSON.stringify({ repo: "maddhruv/tulipfarm", issue: 412, token: "[redacted]" }),
        redactedPaths: ["token"],
        bytes: 184,
      },
      resultPreview: { json: JSON.stringify({ success: true, commentId: 9_912_004 }) },
      meta: { tier: "integration", mutating: true, durationMs: 1_240, agentId: "SupportTriage" },
    },
  },
  {
    caption: "Failed",
    part: {
      kind: "tool",
      toolCallId: "call_01J8M7Q2CC",
      toolName: "slack_post_message",
      args: { argsDigest: "sha256:1d02" },
      status: "done",
      outcome: "error",
      argsPreview: { json: JSON.stringify({ channel: "#ops" }), truncated: true, bytes: 12_400 },
      resultPreview: { json: JSON.stringify({ error: "channel_not_found" }) },
      meta: {
        tier: "integration",
        mutating: true,
        durationMs: 320,
        errorCode: "channel_not_found",
      },
    },
  },
];

const CLUSTER_SPECIMEN: Extract<TimelinePart, { kind: "tool" }>[] = [
  {
    kind: "tool",
    toolCallId: "call_cluster_1",
    toolName: "search_docs",
    args: { argsDigest: "sha256:aa01" },
    status: "done",
    outcome: "ok",
    argsPreview: { json: JSON.stringify({ query: "refund policy" }) },
    resultPreview: { json: JSON.stringify({ success: true, matches: 4 }) },
    meta: { tier: "platform", durationMs: 210 },
  },
  {
    kind: "tool",
    toolCallId: "call_cluster_2",
    toolName: "recall_memory",
    args: { argsDigest: "sha256:aa02" },
    status: "done",
    outcome: "ok",
    argsPreview: { json: JSON.stringify({ scope: "customer:4120" }) },
    resultPreview: { json: JSON.stringify({ success: true, assertions: 2 }) },
    meta: { tier: "platform", durationMs: 90 },
  },
  {
    kind: "tool",
    toolCallId: "call_cluster_3",
    toolName: "kv_get",
    args: { argsDigest: "sha256:aa03" },
    status: "done",
    outcome: "ok",
    argsPreview: { json: JSON.stringify({ key: "billing:tier" }) },
    resultPreview: { json: JSON.stringify({ success: true, value: "pro" }) },
    meta: { tier: "system", durationMs: 40 },
  },
];

const PLAN_SPECIMEN: PlanStep[] = [
  { id: "s1", label: "Read the overdue invoices", status: "done" },
  { id: "s2", label: "Draft the reminder", status: "running" },
  { id: "s3", label: "Send to each owner", status: "pending" },
];

const GITHUB_MARK =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

const GUIDE_LINKS = [
  ["principles", "Design principles"],
  ["stack", "Tech stack"],
  ["tokens", "Design tokens"],
  ["run-tokens", "Run & data palettes"],
  ["typography", "Typography scale"],
  ["status-priority", "Status & priority systems"],
  ["agent-run", "Agent run vocabulary"],
  ["brand-marks", "Brand marks"],
  ["onboarding", "Onboarding: tulip & Companion"],
  ["copy-field", "Copyable values"],
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
        id="run-tokens"
        title="Run & data palettes"
        description="Execution state and categorical data are separate token families. Run tones report what a Run did; data tones encode series and never appear in chrome, status, or brand."
      >
        <h3 className="mb-2 text-sm font-medium">Run state</h3>
        <div className="mb-6 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {RUN_TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-10 ${color}`} />
              <div className="border-t border-border bg-background px-2 py-1.5 font-mono text-xs">
                {label}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mb-2 text-sm font-medium">Tool identity</h3>
        <div className="mb-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {TIER_TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-10 ${color}`} />
              <div className="border-t border-border bg-background px-2 py-1.5 font-mono text-xs">
                {label}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mb-2 text-sm font-medium">Categorical data</h3>
        <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {DATA_TOKENS.map(([label, color]) => (
            <div key={label} className="overflow-hidden rounded-md border border-border">
              <div className={`h-10 ${color}`} />
              <div className="border-t border-border bg-background px-2 py-1.5 font-mono text-xs">
                {label}
              </div>
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
        id="agent-run"
        title="Agent run vocabulary"
        description="A Tool row carries the whole call on one line: which kind of Tool ran, what it did in words, how long it took, and how it ended. Expanding separates Input from Output and names every withheld field. Parts tagged contract-only are typed, reduced and rendered, but no backend event emits them yet."
      >
        <div className="mb-6 space-y-4">
          {TOOL_SPECIMENS.map(({ caption, part }) => (
            <div key={part.toolCallId}>
              <p className="mb-1.5 text-xs text-muted-foreground">{caption}</p>
              <MessagePartView
                part={part}
                streaming={part.status === "running"}
                onApprove={() => undefined}
              />
            </div>
          ))}

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              Consecutive settled calls, folded
            </p>
            <ToolRun parts={CLUSTER_SPECIMEN} foldable onApprove={() => undefined} />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              Step rail
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                contract-only
              </span>
            </p>
            <MessagePartView
              part={{
                kind: "plan",
                planId: "plan-1",
                title: "Chase overdue invoices",
                steps: PLAN_SPECIMEN,
              }}
              onApprove={() => undefined}
            />
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Sources</p>
            <MessagePartView
              part={{
                kind: "sources",
                sources: [
                  { id: "s1", ref: 1, title: "Billing runbook", url: "/knowledge/billing-runbook" },
                  {
                    id: "s2",
                    ref: 2,
                    title: "pgvector indexing",
                    url: "https://github.com/pgvector/pgvector",
                  },
                ],
              }}
              onApprove={() => undefined}
            />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        id="brand-marks"
        title="Brand marks"
        description="Third-party logos, in the brand's own colour. Not every brand ships a mark, so the monogram fallback is a first-class state — and it carries the colour too, because one grey tile among coloured logos reads as a failed image."
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <IntegrationIcon label="GitHub" iconPath={GITHUB_MARK} iconColor="181717" />
            <span className="text-sm">Resolved mark</span>
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon label="Slack" iconColor="4A154B" />
            <span className="text-sm">Monogram, curated colour</span>
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon label="Acme CRM" />
            <span className="text-sm">Uncurated</span>
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon label="Google Workspace" size="sm" iconColor="4285F4" />
            <span className="text-sm">Small</span>
          </div>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          A brand hex is the one colour that cannot be a token — it belongs to someone else and
          arrives as runtime data. It is never rendered as authored: <code>brandInk</code> clamps
          its OKLCH lightness per canvas, because GitHub&rsquo;s <code>#181717</code> is invisible
          on the dark canvas and a pale brand is invisible on the light one. Both corrections ship
          as custom properties so the <code>dark:</code> variant switches them without JavaScript.
        </p>
      </GuideSection>

      <GuideSection
        id="onboarding"
        title="Onboarding: tulip & Companion"
        description="Growth reports real answered-input count, not decoration — stage is state, motion is only the transition between stages. The same bloom face, eyes open, is the persistent in-app Companion."
      >
        <div className="flex flex-wrap items-end gap-6">
          {TULIP_STAGES.map((stage) => (
            <div key={stage} className="flex flex-col items-center gap-2">
              <TulipGrowth stage={stage} width={60} height={80} />
              <span className="font-mono text-xs text-muted-foreground">stage {stage}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          Pre-login (<code>/setup</code>) drives this with answered-question count, no step number
          shown. In-app, stage 3 is fixed — it is the Companion's collapsed glyph, bottom right on{" "}
          <code>sm</code>+ and a top-bar icon below it, with a pulsing dot badge (never a popup)
          when a quest is pending.
        </p>
        <div className="mt-5 max-w-sm rounded-md border border-border bg-card">
          <CompanionPanel
            quests={GUIDE_QUESTS}
            loading={false}
            onDismiss={() => {}}
            onAnswered={() => {}}
            onClose={() => {}}
          />
        </div>
      </GuideSection>

      <GuideSection
        id="copy-field"
        title="Copyable values"
        description="A value the operator has to move somewhere else by hand: a webhook URL, an invite link."
      >
        <CopyField
          value="https://app.example.com/api/v1/hooks/integrations/slack"
          label="example"
        />
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Always confirm the copy. <code>copyText</code> falls back to <code>execCommand</code> on
          insecure origins and can fail outright — a button that looks the same either way leaves
          someone pasting stale clipboard contents into a provider's form.
        </p>
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
        description="Panel, Field and FormStatus are the shared composites every settings surface is assembled from. Visible labels and local help remain part of every field contract."
      >
        <Panel
          title="Panel"
          description="The titled container every settings and detail surface is built from. The title is an h2 — the top bar already names the page."
          footer={
            <div className="flex justify-end">
              <Button size="sm">Save changes</Button>
            </div>
          }
        >
          <form className="grid gap-5 sm:grid-cols-2" onSubmit={(event) => event.preventDefault()}>
            <Field label="Name">
              <Input placeholder="Quarterly planning" />
            </Field>
            <Field label="Status">
              <Select defaultValue="draft">
                <option value="draft">Draft</option>
                <option value="active">Active</option>
              </Select>
            </Field>
            <Field
              label="Description"
              help="Keep it concise and actionable."
              className="sm:col-span-2"
            >
              <Textarea placeholder="Describe the purpose and expected outcome." />
            </Field>
            <Field label="Website" error="Enter a full URL, including https://." required>
              <Input defaultValue="example.com" />
            </Field>
          </form>
        </Panel>

        <div className="mt-6 space-y-3">
          <FormStatus tone="error">Could not reach the API.</FormStatus>
          <FormStatus tone="success">Profile updated.</FormStatus>
        </div>

        <Panel
          title="Rows and empties"
          description="PanelRow separates stacked records; PanelEmpty states the absence in words rather than leaving a blank."
          className="mt-6"
          flush
        >
          <PanelRow>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Production deploy key</p>
              <p className="truncate text-xs text-muted-foreground">Added 12 Mar 2026</p>
            </div>
            <Badge variant="success">Active</Badge>
          </PanelRow>
          <PanelRow>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Staging deploy key</p>
              <p className="truncate text-xs text-muted-foreground">Added 4 Feb 2026</p>
            </div>
            <Badge>Unused</Badge>
          </PanelRow>
        </Panel>

        <Panel title="Nothing stored yet" className="mt-4">
          <PanelEmpty>No credentials are stored for this workspace.</PanelEmpty>
        </Panel>
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
