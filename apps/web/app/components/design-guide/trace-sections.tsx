import { useEffect, useState } from "react";
import { GuideSection } from "~/components/design-guide/guide-section";
import { BookOpen, ExternalLink } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { DiffChip, DiffChipGroup, type DiffLine, ToolChip } from "~/components/ui/tool-chip";
import { Trace, TraceNote, TraceQuery, TraceSource, TraceStep } from "~/components/ui/trace";

const TICKET_DIFF: DiffLine[] = [
  { text: "fields:", tone: "context" },
  { text: "  priority: { type: select, options: [low, high] }", tone: "remove" },
  { text: "  priority: { type: select, options: [low, normal, high, urgent] }", tone: "add" },
  { text: "  breachedAt: { type: datetime, optional: true }", tone: "add" },
  { text: "status: [triage, in_progress, resolved]", tone: "context" },
];

const AGENT_DIFF: DiffLine[] = [
  { text: "name: Support triage", tone: "context" },
  { text: "autonomy: suggest", tone: "remove" },
  { text: "autonomy: approval-required", tone: "add" },
];

const CHANGED_FILES = [
  { file: "resources/ticket.yaml", added: 13, removed: 2, lines: TICKET_DIFF },
  { file: "agents/support-triage.md", added: 74, removed: 41, lines: AGENT_DIFF },
  { file: "routines/daily-digest.yaml", added: 8, removed: 0 },
  { file: "skills/reply-tone.md", added: 21, removed: 3 },
  { file: "integrations/slack.yaml", added: 4, removed: 4 },
];

/**
 * A scripted Soul build, replayed on a tick so the disclosure policy is visible rather than
 * described. Ticks are 700ms; two of the steps deliberately overlap, because a Turn can hold more
 * than one call open at a time and the trace has to stay readable when it does.
 */
const REPLAY = [
  {
    id: "read",
    start: 0,
    end: 2,
    activeLabel: "Reading the Ticket resource type",
    label: "Read the Ticket resource type",
    value: "resources/ticket.yaml",
    detail: ["9 fields, 3 statuses", "Last written 4 days ago by Support triage"],
  },
  {
    id: "search",
    start: 1,
    end: 3,
    activeLabel: "Searching Knowledge",
    label: "Searched Knowledge",
    value: "escalation policy",
    detail: ["4 pages matched", "Top page: Support escalation runbook"],
  },
  {
    id: "write",
    start: 3,
    end: 5,
    activeLabel: "Writing the Ticket resource type",
    label: "Wrote the Ticket resource type",
    value: "resources/ticket.yaml",
    detail: ["+ priority: added normal and urgent", "+ breachedAt: optional datetime"],
  },
  {
    id: "agent",
    start: 3,
    end: 6,
    activeLabel: "Updating the Support triage Agent",
    label: "Updated the Support triage Agent",
    value: "agents/support-triage.md",
    detail: ["Autonomy moved to approval-required", "Granted the Ticket resource type"],
  },
  {
    id: "commit",
    start: 6,
    end: 8,
    activeLabel: "Committing to the Soul",
    label: "Committed to the Soul",
    value: "git commit",
    detail: ["3 files changed", "feat(soul): widen ticket priority"],
  },
] as const;

const REPLAY_TICKS = 8;
const TICK_MS = 700;

function statusAt(tick: number, start: number, end: number) {
  if (tick < start) return "pending" as const;
  return tick < end ? ("running" as const) : ("done" as const);
}

function TraceReplay() {
  const [runId, setRunId] = useState(0);
  const [tick, setTick] = useState(REPLAY_TICKS);

  useEffect(() => {
    if (tick >= REPLAY_TICKS) return;
    const timer = setTimeout(() => setTick((value) => value + 1), TICK_MS);
    return () => clearTimeout(timer);
  }, [tick]);

  const working = tick < REPLAY_TICKS;
  const started = REPLAY.filter((step) => tick >= step.start);
  const done = REPLAY.filter((step) => tick >= step.end).length;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">Following live work</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setRunId((value) => value + 1);
            setTick(0);
          }}
        >
          Replay
        </Button>
      </div>

      <div className={working ? "mt-4 min-h-52" : "mt-4"}>
        <Trace
          key={runId}
          activeLabel="Building the Soul"
          settledLabel={`Ran ${REPLAY.length} tools`}
          working={working}
        >
          {started.map((step) => {
            const status = statusAt(tick, step.start, step.end);
            return (
              <TraceStep
                key={step.id}
                status={status}
                label={step.label}
                activeLabel={step.activeLabel}
                value={step.value}
                mono={step.value.includes("/") || step.value.startsWith("git")}
                detail={step.detail.map((line) => <span key={line}>{line}</span>)}
              />
            );
          })}
        </Trace>
      </div>

      <p className="mt-4 max-w-2xl text-base text-muted-foreground">
        Rows arrive when their work starts, the step in flight shows its detail, and finished steps
        drop back to one line, {done} of {REPLAY.length} settled. When the last one lands the whole
        trace folds to its header. Toggle anything by hand and the policy stops steering it, because
        a panel that reopens under the reader is worse than one that never opened.
      </p>
    </div>
  );
}

function Specimen({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="mb-3 text-xs font-medium text-muted-foreground">{caption}</p>
      {children}
    </div>
  );
}

export function TraceSections() {
  return (
    <>
      <GuideSection
        id="trace"
        title="Trace"
        description="A Trace discloses interior work: the steps, the reasoning, the lookups a Turn ran on its way to an answer. It opens itself while the work is in flight, keeps the live step expanded, and folds to one line once everything settles. It is the only presentation interior work gets, live, settled, failed or waiting on a decision. Nothing in a transcript takes a border except the verbatim payload you open on purpose, because narration you are meant to be able to ignore must never outweigh the answer you asked for."
      >
        <div className="grid gap-4">
          <TraceReplay />

          <div className="grid gap-4 lg:grid-cols-2">
            <Specimen caption="Steps, one still running">
              <Trace activeLabel="Working" settledLabel="Worked" working keepOpen>
                <TraceStep status="done" label="Read the overdue invoices" value="14 records" />
                <TraceStep
                  status="running"
                  label="Drafted the reminder"
                  activeLabel="Drafting the reminder"
                  detail={<span>Matching the tone of the last three reminders sent.</span>}
                />
                <TraceStep status="pending" label="Send to each owner" />
              </Trace>
            </Specimen>

            <Specimen caption="A failure holds itself open">
              <Trace
                activeLabel="Working"
                settledLabel="Stopped after 2 steps"
                working={false}
                keepOpen
              >
                <TraceStep status="done" label="Read the Slack integration" value="slack.yaml" />
                <TraceStep
                  status="error"
                  label="Posted to the ops channel"
                  value="#ops"
                  detail={<span className="font-mono">channel_not_found</span>}
                />
              </Trace>
            </Specimen>

            <Specimen caption="Reasoning">
              <Trace activeLabel="Thinking" settledLabel="Thought process" working={false} keepOpen>
                <TraceNote>
                  Two Agents already write to the Ticket type, so widening the priority field has to
                  keep the existing values valid rather than replace them.
                </TraceNote>
                <TraceNote>
                  The daily digest Routine reads that field, so it needs a pass before the change
                  lands.
                </TraceNote>
              </Trace>
            </Specimen>

            <Specimen caption="Search">
              <Trace
                activeLabel="Searching Knowledge"
                settledLabel="Searched Knowledge"
                working={false}
                keepOpen
              >
                <TraceQuery>escalation policy</TraceQuery>
                <TraceSource
                  ref={1}
                  icon={BookOpen}
                  title="Support escalation runbook"
                  host="Knowledge"
                />
                <TraceSource ref={2} icon={BookOpen} title="On-call rotation" host="Knowledge" />
                <TraceSource
                  ref={3}
                  icon={ExternalLink}
                  title="pgvector indexing"
                  host="github.com"
                  href="https://github.com/pgvector/pgvector"
                />
              </Trace>
            </Specimen>
          </div>
        </div>
      </GuideSection>

      <GuideSection
        id="tool-chips"
        title="Tool chips"
        description="A chip carries the object a step acted on, never the step itself. The verb stays readable while the identifier truncates. A file chip adds what changed, and previews the change on hover and on keyboard focus. Added and removed are their own token pair: deleting a line is not an error, so a diff never borrows the run-state tones."
      >
        <div className="grid gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Specimen caption="Value chips">
              <div className="flex flex-wrap items-center gap-2">
                <ToolChip mono>resources/ticket.yaml</ToolChip>
                <ToolChip mono>pnpm --filter @tulipfarm/web test</ToolChip>
                <ToolChip>Planning the digest…</ToolChip>
                <ToolChip>14 records</ToolChip>
              </div>
            </Specimen>

            <Specimen caption="File chips, hover or tab to preview">
              <div className="flex flex-wrap items-center gap-2">
                <DiffChip file="resources/ticket.yaml" added={13} removed={2} lines={TICKET_DIFF} />
                <DiffChip file="routines/daily-digest.yaml" added={8} removed={0} />
              </div>
            </Specimen>
          </div>

          <Specimen caption="What a Turn changed">
            <Trace
              activeLabel="Building the Soul"
              settledLabel="Ran 3 tools"
              working={false}
              keepOpen
            >
              <TraceStep
                status="done"
                label="Read"
                value="resources/ticket.yaml"
                mono
                detail={<span>9 fields, 3 statuses.</span>}
              />
              <TraceStep
                status="done"
                label="Wrote"
                value="agents/support-triage.md"
                mono
                diff={{ added: 74, removed: 41 }}
              />
              <TraceStep status="done" label="Ran" value="soul validate" mono />
            </Trace>
            <div className="mt-3 border-t border-run-border pt-3">
              <DiffChipGroup files={CHANGED_FILES} />
            </div>
            <p className="mt-3 max-w-2xl text-base text-muted-foreground">
              The chip strip is the receipt of a Turn that wrote to the Soul. `+N more` reveals the
              rest rather than being a count with nothing behind it.
            </p>
          </Specimen>
        </div>
      </GuideSection>
    </>
  );
}
