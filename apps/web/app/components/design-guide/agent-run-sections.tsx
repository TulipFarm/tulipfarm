import { ApprovalCard } from "~/components/chat/approval-card";
import { MessagePartView } from "~/components/chat/parts";
import { ToolTrace } from "~/components/chat/tool-trace";
import { GuideSection } from "~/components/design-guide/guide-section";
import type { TimelinePart } from "~/lib/chat/types";

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

const FAILED_SPECIMEN: Extract<TimelinePart, { kind: "tool" }>[] = [
  ...CLUSTER_SPECIMEN,
  {
    kind: "tool",
    toolCallId: "call_cluster_4",
    toolName: "slack_post_message",
    args: { argsDigest: "sha256:aa04" },
    status: "done",
    outcome: "error",
    argsPreview: { json: JSON.stringify({ channel: "#ops" }) },
    resultPreview: { json: JSON.stringify({ error: "channel_not_found" }) },
    meta: { tier: "integration", mutating: true, durationMs: 320, errorCode: "channel_not_found" },
  },
];

const LIVE_SPECIMEN: Extract<TimelinePart, { kind: "tool" }>[] = [
  {
    kind: "tool",
    toolCallId: "call_live_1",
    toolName: "list_resource_types",
    args: {},
    status: "done",
    outcome: "ok",
    resultPreview: { json: JSON.stringify({ success: true, types: [1, 2, 3, 4] }) },
    meta: { tier: "platform", durationMs: 180 },
  },
  {
    kind: "tool",
    toolCallId: "call_live_2",
    toolName: "search_knowledge",
    args: { argsDigest: "sha256:bb02" },
    status: "done",
    outcome: "ok",
    argsPreview: { json: JSON.stringify({ query: "escalation policy" }) },
    resultPreview: { json: JSON.stringify({ success: true, matches: 4 }) },
    meta: { tier: "platform", durationMs: 640 },
  },
  {
    kind: "tool",
    toolCallId: "call_live_3",
    toolName: "create_record",
    args: { argsDigest: "sha256:bb03" },
    status: "running",
    argsPreview: { json: JSON.stringify({ name: "Ticket #4102" }) },
    meta: { tier: "platform" },
  },
];

const APPROVAL_SPECIMEN: Extract<TimelinePart, { kind: "tool" }>[] = [
  {
    kind: "tool",
    toolCallId: "call_appr_1",
    toolName: "search_docs",
    args: { argsDigest: "sha256:cc01" },
    status: "done",
    outcome: "ok",
    argsPreview: { json: JSON.stringify({ query: "refund policy" }) },
    resultPreview: { json: JSON.stringify({ success: true, matches: 4 }) },
    meta: { tier: "platform", durationMs: 210 },
  },
  {
    kind: "tool",
    toolCallId: "call_appr_2",
    toolName: "send_email",
    args: { argsDigest: "sha256:cc02" },
    status: "running",
    argsPreview: { json: JSON.stringify({ to: "ops@tulipfarm.dev", subject: "Refund issued" }) },
    approval: {
      approvalId: "appr_1",
      status: "pending",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
    meta: { tier: "integration", mutating: true },
  },
];

export function AgentRunSections() {
  return (
    <GuideSection
      id="agent-run"
      title="Agent run vocabulary"
      description="A run of Tool calls draws as one Trace: a rail, no border, a step per call. A step names what it did, whether the Tool can write, and how it ended; expanding it separates Input from Output and names every withheld field."
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
            A run while it is still the live edge of the Turn
          </p>
          <ToolTrace parts={LIVE_SPECIMEN} pending foldable={false} onApprove={() => undefined} />
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            The same shape once the Turn moved on, folded to its header
          </p>
          <ToolTrace
            parts={CLUSTER_SPECIMEN}
            pending={false}
            foldable
            onApprove={() => undefined}
          />
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            A run that failed folds too, but the header names the count
          </p>
          <ToolTrace parts={FAILED_SPECIMEN} pending={false} foldable onApprove={() => undefined} />
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            A run holding a decision. The ask sits on the rail, never behind a disclosure
          </p>
          <ToolTrace
            parts={APPROVAL_SPECIMEN}
            pending
            foldable={false}
            onApprove={() => undefined}
          />
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Once decided, the ask drops to a settled line no heavier than the steps around it
          </p>
          <div className="ml-[6px] flex flex-col gap-0.5 border-l border-run-border py-1 pl-3.5">
            {(["approved", "denied", "timeout"] as const).map((status) => (
              <ApprovalCard
                key={status}
                toolName="send_email"
                approval={{ approvalId: `appr_${status}`, status }}
                onDecide={() => undefined}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            A handoff and a refusal, both narration, so neither takes a box
          </p>
          <MessagePartView
            part={{ kind: "agent-handoff", to: "Billing", reason: "needs invoice authority" }}
            onApprove={() => undefined}
          />
          <MessagePartView
            part={{
              kind: "guardrail",
              stage: "output",
              reason: "policy",
              message: "Refunds over $500 need a human decision.",
            }}
            onApprove={() => undefined}
          />
        </div>
      </div>
    </GuideSection>
  );
}
