/** Summaries derive only from the wire data; they never invent counts, duration, or outcome. */

import type { TimelinePart, ToolTier } from "~/lib/chat/types";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/** Hide plumbing/presentation rows: their output already renders as the thing they produced. */
const PRESENTATION_TOOL_NAMES = new Set(["present", "update_presentation", "request_input"]);

/**
 * Whether this Tool builds the reply's own UI rather than doing work the reader follows.
 *
 * These never earn a Tool row, in any outcome. A reader watching an answer take shape does not
 * think of the rendering as a step the agent took, and a failed `present` that the agent
 * immediately retries is machinery, not evidence — showing it puts a red row above a table that
 * rendered perfectly well.
 */
export function isPresentationToolPart(part: ToolPart): boolean {
  return PRESENTATION_TOOL_NAMES.has(part.toolName);
}

/** Whether this Tool row is suppressed because its output already renders as something else. */
export function isHiddenToolPart(part: ToolPart): boolean {
  if (part.toolName === "cite_sources") return true;
  return isPresentationToolPart(part);
}

export type ToolFamily =
  | "knowledge"
  | "memory"
  | "storage"
  | "github"
  | "slack"
  | "surface"
  | "time"
  | "delegation"
  | "generic";

/** Longest prefixes must match first so specific Tool names are not shortened too early. */
export function toolFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase();
  if (name.startsWith("github_")) return "github";
  if (name.includes("slack")) return "slack";
  if (name.startsWith("kv_")) return "storage";
  if (name.includes("memory") || name.startsWith("recall_") || name.startsWith("remember_")) {
    return "memory";
  }
  if (name === "search_docs" || name === "read_page" || name.startsWith("knowledge")) {
    return "knowledge";
  }
  if (name === "present" || name === "update_presentation" || name === "request_input") {
    return "surface";
  }
  if (name === "get_current_time") return "time";
  if (name === "spawn_subagent" || name.startsWith("delegate") || name.startsWith("transfer")) {
    return "delegation";
  }
  return "generic";
}

/** A Tool whose tier the stream did not name still has a family, so identity never falls back to nothing. */
export function toolTierLabel(tier: ToolTier | undefined, family: ToolFamily): string {
  if (tier !== undefined) return tier;
  return family === "github" || family === "slack" ? "integration" : "platform";
}

const VERB_BY_SUFFIX: readonly (readonly [RegExp, string])[] = [
  [/^search_docs$/, "Searched docs"],
  [/^read_page$/, "Read page"],
  [/^get_current_time$/, "Checked the time"],
  [/^spawn_subagent$/, "Spawned helper"],
  [/^complete_state$/, "Completed step"],
  [/^send_slack_message$/, "Sent Slack message"],
  [/_search$/, "Searched"],
  [/_read$/, "Read"],
  [/_list$/, "Listed"],
  [/_get$/, "Read"],
  [/_set$/, "Saved"],
  [/_delete$/, "Deleted"],
  [/_create$/, "Created"],
  [/_comment$/, "Commented on"],
  [/_review$/, "Reviewed"],
  [/_merge$/, "Merged"],
  [/_close$/, "Closed"],
  [/_assign$/, "Assigned"],
  [/_label$/, "Labelled"],
  [/_push$/, "Pushed to"],
  [/^skill$/, "Loaded skill"],
];

/** Verb-leading Tool names are rebuilt after exact/suffix matches stay authoritative. */
const VERB_BY_PREFIX: readonly (readonly [RegExp, string])[] = [
  [/^list_/, "Listed"],
  [/^search_/, "Searched"],
  [/^read_/, "Read"],
  [/^get_/, "Read"],
  [/^fetch_/, "Fetched"],
  [/^create_/, "Created"],
  [/^update_/, "Updated"],
  [/^write_/, "Wrote"],
  [/^set_/, "Saved"],
  [/^save_/, "Saved"],
  [/^delete_/, "Deleted"],
  [/^remove_/, "Removed"],
  [/^add_/, "Added"],
  [/^send_/, "Sent"],
  [/^run_/, "Ran"],
  [/^open_/, "Opened"],
  [/^close_/, "Closed"],
];

/** Quote prose arguments so multi-word input stays visually bound to the Tool call. */
const QUOTED_KEYS: readonly string[] = ["query", "q", "search", "text", "message", "body", "title"];

/** Keys naming the thing a repo-scoped call acts on, so `repo` can carry its number: `owner/x#412`. */
const REPO_NUMBER_KEYS: readonly string[] = ["issue", "pullRequest", "pull_number", "number", "pr"];

/** Argument keys worth putting in a summary, most specific first. */
const SUBJECT_KEYS: readonly string[] = [
  "query",
  "q",
  "search",
  "path",
  "file",
  "url",
  "page",
  "pageId",
  "title",
  "name",
  "key",
  "channel",
  "repo",
  "repository",
  "owner",
  "scope",
  "id",
  "number",
  "issue",
  "pullRequest",
  "agentId",
  "skill",
  "text",
  "message",
  "body",
];

const MAX_SUBJECT_CHARS = 64;

/** Turns `github_pull_request_read` into `Github pull request read` when no verb rule matches. */
function humanizeToolName(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, " ").trim();
  if (words.length === 0) return "Tool call";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Use the name-derived object only when arguments name nothing. */
type ToolVerb = { verb: string; fallbackObject?: string };

/** `Listed agent` is wrong where `Listed agents` is right; a list verb takes a plural object. */
function objectFor(verb: string, object: string): string {
  if (verb !== "Listed" || object.endsWith("s")) return object;
  return `${object}s`;
}

function verbFor(toolName: string): ToolVerb | undefined {
  const name = toolName.toLowerCase();
  for (const [pattern, verb] of VERB_BY_SUFFIX) {
    if (!pattern.test(name)) continue;
    const object = name.replace(pattern, "").replace(/[_-]+/g, " ").trim();
    return {
      verb,
      fallbackObject: object.length === 0 ? undefined : objectFor(verb, object),
    };
  }
  for (const [pattern, verb] of VERB_BY_PREFIX) {
    if (!pattern.test(name)) continue;
    // A leading verb keeps its object inline: the phrase is plainly `Listed resource types`, and
    // an argument still reads correctly after it (`Created space Ops`).
    const object = name.replace(pattern, "").replace(/[_-]+/g, " ").trim();
    return { verb: object.length === 0 ? verb : `${verb} ${object}` };
  }
  return undefined;
}

function truncateSubject(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_SUBJECT_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_SUBJECT_CHARS)}…`;
}

/** Only scalar arguments are safe to headline; payload fragments belong in detail. */
export function toolSubject(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;

  for (const key of SUBJECT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const subject = truncateSubject(value);
      if (QUOTED_KEYS.includes(key)) return `"${subject}"`;
      if (key === "repo" || key === "repository") {
        const number = repoNumber(record);
        return number === undefined ? subject : `${subject}#${number}`;
      }
      return subject;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** The issue or pull request number a repo-scoped call names, when it names one. */
function repoNumber(record: Record<string, unknown>): number | undefined {
  for (const key of REPO_NUMBER_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * `skill` is one Tool with several modes, and only the reading ones are a load.
 *
 * Without this, a call that executed a Skill's code in the sandbox would be summarised as
 * "Loaded skill", claiming a read for a row where something actually ran.
 */
function skillRunVerb(toolName: string, args: unknown): ToolVerb | undefined {
  if (toolName !== "skill") return undefined;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const mode = (args as Record<string, unknown>).mode;
  if (mode !== "run" && mode !== "shell") return undefined;
  return { verb: "Ran skill", fallbackObject: "command" };
}

/** Summary text never asserts outcome; the status glyph owns success/failure. */
export function describeToolCall(toolName: string, args: unknown, serverSummary?: string): string {
  const trimmed = serverSummary?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;

  const verb = skillRunVerb(toolName, args) ?? verbFor(toolName);
  const subject = toolSubject(args);

  if (verb === undefined) {
    return subject === undefined
      ? humanizeToolName(toolName)
      : `${humanizeToolName(toolName)} · ${subject}`;
  }
  if (subject !== undefined) return `${verb.verb} ${subject}`;
  return verb.fallbackObject === undefined ? verb.verb : `${verb.verb} ${verb.fallbackObject}`;
}

/**
 * Present participle for every past verb this module can produce. Kept as one map rather than a
 * second tense column on `VERB_BY_*`, because the leading word is the only part that changes:
 * `Pushed to owner/x#412` differs from `Pushing to owner/x#412` by exactly one token.
 */
const PRESENT_BY_PAST: Readonly<Record<string, string>> = {
  Added: "Adding",
  Assigned: "Assigning",
  Called: "Calling",
  Checked: "Checking",
  Closed: "Closing",
  Commented: "Commenting",
  Completed: "Completing",
  Created: "Creating",
  Deleted: "Deleting",
  Fetched: "Fetching",
  Labelled: "Labelling",
  Listed: "Listing",
  Loaded: "Loading",
  Merged: "Merging",
  Opened: "Opening",
  Pushed: "Pushing",
  Ran: "Running",
  Read: "Reading",
  Removed: "Removing",
  Reviewed: "Reviewing",
  Saved: "Saving",
  Searched: "Searching",
  Sent: "Sending",
  Updated: "Updating",
  Wrote: "Writing",
};

/**
 * The same summary, said as work still in progress: `Listed agents` → `Listing agents`.
 *
 * A row that says `Read the invoice` beside a spinner claims to be finished, so a live Tool step
 * needs the present tense. Returns `undefined` when the phrase does not start with a verb this
 * module wrote — a server-supplied summary or a humanized Tool name is not ours to conjugate, and
 * a caller should fall back to the settled label rather than guess.
 */
export function describeToolCallActive(summary: string): string | undefined {
  const [first, ...rest] = summary.split(" ");
  if (first === undefined) return undefined;
  const present = PRESENT_BY_PAST[first];
  if (present === undefined) return undefined;
  return [present, ...rest].join(" ");
}

/** Keys whose numeric value is a count worth showing on a collapsed row. */
const COUNT_KEYS: readonly string[] = ["count", "total", "matches", "results"];

/** Envelope keys to look inside before giving up — a result is usually wrapped. */
const ENVELOPE_KEYS: readonly string[] = ["data", "result", "output", "value"];

function plural(count: number, noun: string): string {
  const singular = noun.endsWith("s") ? noun.slice(0, -1) : noun;
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/** Output facts come only from explicit preview/result fields; otherwise stay silent. */
export function describeToolResult(part: ToolPart): string | undefined {
  let parsed: unknown;
  if (part.resultPreview !== undefined) {
    try {
      parsed = JSON.parse(part.resultPreview.json);
    } catch {
      return undefined;
    }
  } else {
    parsed = part.result;
  }

  for (let depth = 0; depth < 2; depth += 1) {
    if (Array.isArray(parsed)) return plural(parsed.length, "item");
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const record = parsed as Record<string, unknown>;

    for (const key of COUNT_KEYS) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return plural(value, "result");
    }

    // The longest array in the payload is the payload, in practice: `{ success, skills: [...] }`.
    let best: { key: string; length: number } | undefined;
    for (const [key, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue;
      if (best === undefined || value.length > best.length) best = { key, length: value.length };
    }
    if (best !== undefined) return plural(best.length, best.key);

    const envelope = ENVELOPE_KEYS.map((key) => record[key]).find((value) => value !== undefined);
    if (envelope === undefined) return undefined;
    parsed = envelope;
  }
  return undefined;
}

/** Keep sub-second durations in milliseconds. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/** Human size for the "how much was withheld" line on a truncated preview. */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} kB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
