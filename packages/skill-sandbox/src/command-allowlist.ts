/**
 * Matches a model-supplied shell command against the patterns a Skill declares in its SKILL.md
 * `allowedCommands` frontmatter.
 *
 * A command the model copied out of a fenced block in the Skill body is model input, not authored
 * code. The allowlist is what makes such a command runnable at all, and it comes from the signed
 * bundle, so the trust anchor stays with the Soul rather than with the model.
 *
 * Two pattern forms, following the idea behind Claude Code's `Bash(...)` rules:
 *
 * - `python3 -c:*` — prefix. Matches the prefix exactly or followed by whitespace, so `python3 -c`
 *   never matches `python3 -config`.
 * - `python3 --version` — exact, after whitespace normalization.
 *
 * **This list is not the containment boundary.** Any pattern naming an interpreter permits
 * arbitrary code in that language — `node -e:*` and `node <<'JS'` are the same power. What
 * contains a command is the sandbox it runs in: read-only, non-root, all capabilities dropped,
 * and no network route except an allowlisting proxy. The patterns express author intent, and stop
 * the model reaching for a command the Skill never described.
 */

/** Operators that would run a second command the matched pattern never covered. */
const COMMAND_CHAINING = /;|\|\||&&|\||`|\$\(/;

/** A heredoc opener, after which following lines are data for the interpreter, not commands. */
const HEREDOC = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/;

export type CommandRefusalReason =
  | "no_allowlist"
  | "command_chaining"
  | "unterminated_heredoc"
  | "not_allowed";

export type CommandRefusal =
  | { readonly reason: "no_allowlist" }
  | { readonly reason: "command_chaining" }
  | { readonly reason: "unterminated_heredoc" }
  | { readonly reason: "not_allowed"; readonly patterns: readonly string[] };

export type CommandDecision =
  | { readonly allowed: true; readonly matchedPattern: string }
  | ({ readonly allowed: false } & CommandRefusal);

/** Collapse runs of whitespace so pattern comparison is not defeated by spacing alone. */
function normalize(text: string): string {
  return text.trim().replace(/[ \t]+/g, " ");
}

function matches(firstLine: string, pattern: string): boolean {
  const isPrefix = pattern.endsWith(":*");
  const wanted = normalize(isPrefix ? pattern.slice(0, -2) : pattern);
  if (wanted.length === 0) return false;
  if (!isPrefix) return firstLine === wanted;
  return firstLine === wanted || firstLine.startsWith(`${wanted} `);
}

/**
 * Decide whether `command` may run for a Skill declaring `patterns`.
 *
 * Fails closed: a Skill with no `allowedCommands` can run nothing.
 *
 * Only the first line is matched, because that is where the interpreter is invoked. Extra lines
 * are accepted only when the first line opens a heredoc, since a heredoc body is data the
 * interpreter reads rather than further shell commands. Without that rule a multi-line string
 * could satisfy a prefix pattern on line one and run anything on line two.
 */
export function decideCommand(
  command: string,
  patterns: readonly string[] | undefined
): CommandDecision {
  if (patterns === undefined || patterns.length === 0) {
    return { allowed: false, reason: "no_allowlist" };
  }

  const lines = command.split(/\r?\n/);
  const rawFirstLine = lines[0] ?? "";
  const firstLine = normalize(rawFirstLine);
  if (firstLine.length === 0) return { allowed: false, reason: "not_allowed", patterns };
  if (COMMAND_CHAINING.test(firstLine)) return { allowed: false, reason: "command_chaining" };

  const heredoc = HEREDOC.exec(rawFirstLine);
  const rest = lines.slice(1);
  if (rest.some((line) => line.trim().length > 0)) {
    if (heredoc === null) return { allowed: false, reason: "command_chaining" };
    // The body is only data while the delimiter actually arrives. Without it the shell would keep
    // consuming, so the tail would not be the heredoc content it looks like.
    const delimiter = heredoc[0].replace(/^<<-?\s*/, "").replace(/['"]/g, "");
    const closedAt = rest.findIndex((line) => line.trim() === delimiter);
    if (closedAt === -1) return { allowed: false, reason: "unterminated_heredoc" };
    // Past the delimiter the shell is reading commands again, and nothing matched those against a
    // pattern. Treating the body as data is only sound while the body is the whole remainder.
    if (rest.slice(closedAt + 1).some((line) => line.trim().length > 0)) {
      return { allowed: false, reason: "command_chaining" };
    }
  }

  const matched = patterns.find((pattern) => matches(firstLine, pattern));
  if (matched !== undefined) return { allowed: true, matchedPattern: matched };
  return { allowed: false, reason: "not_allowed", patterns };
}
