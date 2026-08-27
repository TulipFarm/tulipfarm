import type { TimelinePart } from "~/lib/chat/types";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

/** What the caller wrote for the helper, and what the helper wrote back. */
interface SubagentTrace {
  readonly name?: string;
  readonly instructions?: string;
  readonly task?: string;
  readonly toolNames?: readonly string[];
  readonly status?: string;
  readonly answer?: string;
}

/**
 * The work one ad-hoc helper did, inside the step that spawned it.
 *
 * A sub-agent has no Conversation, so this panel is the only place its work is ever visible. That
 * makes it evidence rather than decoration: an operator reading back a Turn has to be able to see
 * that a helper ran, what it was told, what it was allowed to touch, and what it answered.
 *
 * The instructions are shown verbatim and labelled as written by the agent, because that is the
 * fact a reader most needs and least expects — for a Soul-defined helper a person wrote them and
 * can be asked about them, and here nobody did. Summarising them would hide exactly the thing
 * worth reviewing.
 */
export function SubagentPanel({ part }: { part: ToolPart }) {
  const trace = traceOf(part);
  if (trace === undefined) return null;

  const tools = trace.toolNames ?? [];
  return (
    <div className="space-y-2 border-l-2 border-tool-mutating/30 pl-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-foreground">{trace.name ?? "Helper"}</span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          agent-written helper
        </span>
      </div>

      {trace.instructions === undefined ? null : (
        <Field label="Told to be">{trace.instructions}</Field>
      )}
      {trace.task === undefined ? null : <Field label="Asked">{trace.task}</Field>}

      {/*
       * Said out loud in both directions. "No tools" is the common case and the reassuring one, so
       * leaving it unsaid would make a helper that holds nothing look the same as one whose grants
       * the trace simply failed to report.
       */}
      <Field label="Could use">
        {tools.length === 0 ? "No tools: reasoning only" : tools.join(", ")}
      </Field>

      {trace.answer === undefined || trace.answer.length === 0 ? null : (
        <Field label="Answered">{trace.answer}</Field>
      )}
      {trace.status === "failed" ? (
        <Field label="Answered">
          <span className="text-run-error">Did not finish</span>
        </Field>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="whitespace-pre-wrap break-words text-foreground/90">{children}</div>
    </div>
  );
}

/**
 * Reads the spawn out of the step's arguments and result.
 *
 * The redacted previews are authoritative wherever they exist, for the same reason they are in
 * `ToolInspector`: a guard that removed something from the preview must not be undone by reading
 * the raw value beside it.
 */
export function traceOf(part: ToolPart): SubagentTrace | undefined {
  if (part.toolName !== SPAWN_SUBAGENT_TOOL) return undefined;
  const args = record(decode(part.argsPreview?.json) ?? part.args);
  const result = record(decode(part.resultPreview?.json) ?? part.result);
  const data = record(result?.data) ?? result;

  const trace: SubagentTrace = {
    ...str(args?.name, "name"),
    ...str(args?.instructions, "instructions"),
    ...str(args?.task, "task"),
    ...(Array.isArray(args?.toolNames)
      ? { toolNames: args.toolNames.filter((n): n is string => typeof n === "string") }
      : {}),
    ...str(data?.status, "status"),
    ...str(data?.answer, "answer"),
  };
  return Object.keys(trace).length === 0 ? undefined : trace;
}

function str<K extends string>(value: unknown, key: K): { [P in K]?: string } {
  return typeof value === "string" && value.trim().length > 0
    ? ({ [key]: value } as { [P in K]?: string })
    : ({} as { [P in K]?: string });
}

function decode(json: string | undefined): unknown {
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
