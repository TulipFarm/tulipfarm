import type { ToolCallResult } from "../tools/types";

/**
 * Server-side render of a terminal/view tool result into an A2UI `tf-*` HTML block. The string is
 * emitted as an `a2ui` SSE event and rendered in the sandboxed iframe (DOMPurify + CSP) in the chat
 * shell. Interactive controls carry a `data-a2ui-send` JSON payload that the in-iframe runtime posts
 * back through the `agent` bridge channel on click (see lib/a2ui/runtime.ts).
 *
 * Only three tools produce a view: `compose_view` (passthrough HTML), `present_choices`, and
 * `suggest_agent`. Every other tool — and every failed result — returns `null` (no a2ui event).
 * All agent-controlled strings are HTML-escaped so a `"`/`<` in a label cannot break out of the
 * attribute or tag and smuggle a different `data-a2ui-send` payload.
 */

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPE[c] as string);
}

/** Serialize a postback payload into an HTML-escaped `data-a2ui-send` attribute value. */
function sendAttr(payload: unknown): string {
  return `data-a2ui-send="${esc(JSON.stringify(payload))}"`;
}

interface Choice {
  label: string;
  value: string;
  description?: string;
}

function renderChoices(data: { question: string; choices: Choice[] }): string {
  const buttons = data.choices
    .map((c) => {
      const attr = sendAttr({ kind: "choice", value: c.value, label: c.label });
      const desc = c.description
        ? `<tf-text data-tone="muted" data-size="sm">${esc(c.description)}</tf-text>`
        : "";
      return `<tf-button ${attr}>${esc(c.label)}</tf-button>${desc}`;
    })
    .join("");
  return `<tf-card><tf-text>${esc(data.question)}</tf-text>${buttons}</tf-card>`;
}

function renderSuggestAgent(data: {
  agentId: string;
  agentName: string;
  reason: string | null;
}): string {
  const reason = data.reason
    ? `<tf-text data-tone="muted" data-size="sm">${esc(data.reason)}</tf-text>`
    : "";
  const label = `Switch to ${data.agentName}`;
  const attr = sendAttr({ kind: "suggest_agent", agentId: data.agentId, label });
  return `<tf-alert data-tone="brand"><tf-text>Suggested agent: ${esc(
    data.agentName
  )}</tf-text>${reason}<tf-button ${attr}>${esc(label)}</tf-button></tf-alert>`;
}

export function renderA2uiHtml(toolName: string, result: ToolCallResult): string | null {
  if (!result.success) return null;
  const data = result.data as Record<string, unknown>;
  switch (toolName) {
    case "compose_view":
      return typeof data.html === "string" && data.html.length > 0 ? data.html : null;
    case "present_choices":
      return renderChoices(data as unknown as { question: string; choices: Choice[] });
    case "suggest_agent":
      return renderSuggestAgent(
        data as unknown as { agentId: string; agentName: string; reason: string | null }
      );
    default:
      return null;
  }
}
