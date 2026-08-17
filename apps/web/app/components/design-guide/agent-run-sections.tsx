import { MessagePartView } from "~/components/chat/parts";
import { ToolRun } from "~/components/chat/tool-call";
import { GuideSection } from "~/components/design-guide/guide-section";
import type { PlanStep, TimelinePart } from "~/lib/chat/types";

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
    toolName: "update_memory",
    args: { argsDigest: "sha256:aa02" },
    status: "done",
    outcome: "ok",
    argsPreview: { json: JSON.stringify({ section: "working_context" }) },
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

export function AgentRunSections() {
  return (
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
          <p className="mb-1.5 text-xs text-muted-foreground">Consecutive settled calls, folded</p>
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
  );
}
