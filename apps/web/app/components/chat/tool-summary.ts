/**
 * Turns a Tool call into the words and identity a reader actually needs.
 *
 * Everything here is derived from data the wire already carries — the Tool's name and the redacted
 * argument preview — so a row never claims more than the stream said. Nothing invents a duration, a
 * record count, or an outcome. When there is nothing to derive, the fallbacks degrade to the Tool's
 * own name rather than to filler.
 *
 * Kept free of React so the wording rules can be tested directly.
 */

import type { TimelinePart, ToolTier } from "~/lib/chat/types";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/**
 * Tools whose own output is the thing the reader already sees, so their row would be noise.
 *
 * `cite_sources` is citation plumbing: its result renders as the source cards and the inline `[n]`
 * links. The presentation Tools render as a native Surface. A FAILED presentation call still shows
 * its row, because then there is no Surface and the error is the only evidence something happened.
 */
const PRESENTATION_TOOL_NAMES = new Set(["present", "update_presentation", "request_input"]);

/**
 * Whether a Tool reported success.
 *
 * Reads the redacted preview first, because on a live stream `result` is only the status envelope.
 * A restored conversation carries the verbatim result instead, so both shapes are checked.
 */
export function toolSucceeded(part: ToolPart): boolean {
  if (part.outcome === "error") return false;
  const candidates: unknown[] = [];
  if (part.resultPreview !== undefined) {
    try {
      candidates.push(JSON.parse(part.resultPreview.json));
    } catch {
      // A preview that will not parse tells us nothing about success; fall through to `result`.
    }
  }
  candidates.push(part.result);

  return candidates.some(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "success" in value &&
      (value as { success?: unknown }).success === true
  );
}

/** Whether this Tool row is suppressed because its output already renders as something else. */
export function isHiddenToolPart(part: ToolPart): boolean {
  if (part.toolName === "cite_sources") return true;
  return PRESENTATION_TOOL_NAMES.has(part.toolName) && toolSucceeded(part);
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

/**
 * Which family a Tool belongs to, matched on its registered name.
 *
 * Ordered longest-prefix first: `github_pull_request_read` must not be read as a bare `read`. A
 * name nobody anticipated falls to `generic`, which is a real state, not a gap.
 */
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
  if (name === "call_skill" || name.startsWith("delegate") || name.startsWith("transfer")) {
    return "delegation";
  }
  return "generic";
}

/** A Tool whose tier the stream did not name still has a family, so identity never falls back to nothing. */
export function toolTierLabel(tier: ToolTier | undefined, family: ToolFamily): string {
  if (tier !== undefined) return tier;
  return family === "github" || family === "slack" ? "integration" : "platform";
}

/**
 * The verb each Tool name leads with, so a row reads as something that happened rather than as an
 * identifier. Matched by suffix or exact name; anything unmatched is humanized from the name itself.
 */
const VERB_BY_SUFFIX: readonly (readonly [RegExp, string])[] = [
  [/^search_docs$/, "Searched docs"],
  [/^read_page$/, "Read page"],
  [/^get_current_time$/, "Checked the time"],
  [/^call_skill$/, "Called skill"],
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
  [/^recall_memory$/, "Recalled memory"],
  [/^remember_correction$/, "Remembered correction"],
  [/^load_skill$/, "Loaded skill"],
];

/**
 * Tools whose name leads with the verb — `list_resource_types`, `create_space`. The suffix table
 * cannot match these, so they fell through to the humanized name and rendered as imperatives
 * ("List resource types") next to past-tense rows in the same run. The remainder of the name is
 * the object the verb acts on, so the phrase is rebuilt whole: `Listed resource types`.
 *
 * Checked after the suffix and exact-name table, which stays authoritative — `get_current_time`
 * reads better as "Checked the time" than as "Read current time".
 */
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

/**
 * Keys whose value is prose a person typed, not an identifier. These get quoted so a multi-word
 * value reads as the argument it is rather than running into the verb: `Searched docs "refund
 * policy"`, not `Searched docs refund policy`.
 */
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

/**
 * A matched verb, plus the object the Tool name implies.
 *
 * The object is held separately because a phrasal verb only wants one of the two: `Commented on`
 * reads correctly with the argument (`Commented on maddhruv/tulipfarm#412`) and badly with both
 * (`Commented on github issue maddhruv/tulipfarm#412`). So the name-derived object is a fallback
 * used only when the arguments name nothing — which is what turned rows into a bare "Listed".
 */
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

/**
 * Picks the one argument worth naming. Scalars only: an object or array subject would put a
 * fragment of a payload in a headline, which is exactly what the expanded pane is for.
 */
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
 * The one-line human summary shown on a collapsed row.
 *
 * A server-supplied summary always wins: it was written by the side that ran the call and knows
 * what it did. Otherwise the verb and the subject are composed from real arguments, and failing
 * that the Tool's own name is used. The result never asserts an outcome — a row says what was
 * attempted, and the status glyph beside it says how it went.
 */
export function describeToolCall(toolName: string, args: unknown, serverSummary?: string): string {
  const trimmed = serverSummary?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;

  const verb = verbFor(toolName);
  const subject = toolSubject(args);

  if (verb === undefined) {
    return subject === undefined
      ? humanizeToolName(toolName)
      : `${humanizeToolName(toolName)} · ${subject}`;
  }
  if (subject !== undefined) return `${verb.verb} ${subject}`;
  return verb.fallbackObject === undefined ? verb.verb : `${verb.verb} ${verb.fallbackObject}`;
}

/** Keys whose numeric value is a count worth showing on a collapsed row. */
const COUNT_KEYS: readonly string[] = ["count", "total", "matches", "results"];

/** Envelope keys to look inside before giving up — a result is usually wrapped. */
const ENVELOPE_KEYS: readonly string[] = ["data", "result", "output", "value"];

function plural(count: number, noun: string): string {
  const singular = noun.endsWith("s") ? noun.slice(0, -1) : noun;
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * The one fact from a Tool's output worth putting on the collapsed row.
 *
 * The complaint this answers is real: a row that shows only a green check makes the reader open
 * every call to learn anything. So a row now carries the shape of what came back — how many
 * records, or a short scalar.
 *
 * Everything here is read off the redacted preview (or a restored verbatim result). Nothing is
 * inferred, counted client-side, or guessed: when the payload does not plainly say, this returns
 * `undefined` and the row simply stays quiet rather than asserting something it cannot support.
 */
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

/**
 * Human duration. Sub-second stays in whole milliseconds because rounding `412ms` to `0.4s` reads
 * as less precise than the measurement actually was.
 */
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
