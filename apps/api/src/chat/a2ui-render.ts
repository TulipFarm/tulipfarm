import { compileSurface } from "../a2ui/compiler";
import { esc, sendAttr } from "../a2ui/escape";
import type { A2uiSpec } from "../a2ui/spec";
import type { ToolCallResult } from "../tools/types";

/**
 * Server-side render of a terminal/view tool result into an A2UI `tf-*` HTML block. The string is
 * emitted as an `a2ui` SSE event and rendered in the sandboxed iframe (DOMPurify + CSP) in the chat
 * shell. Interactive controls carry a `data-a2ui-send` JSON payload that the in-iframe runtime posts
 * back through the `agent` bridge channel on click (see lib/a2ui/runtime.ts).
 *
 * View-producing tools: `compose_view` (passthrough HTML), `present_choices`, `suggest_agent`, and
 * `render_surface` (declarative A2UI spec compiled to tf-* HTML). Every other tool — and every
 * failed result — returns `null` (no a2ui event). All agent-controlled strings are HTML-escaped (via
 * a2ui/escape) so a `"`/`<` in a label cannot break out and smuggle a different `data-a2ui-send`.
 */

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

/**
 * The structured payload of an `a2ui` SSE event. The legacy view tools emit `{ html }`; `render_surface`
 * emits a `createSurface` op (re-emitting it for the same surfaceId replaces the surface in place);
 * `update_surface` emits `updateDataModel` with the changed leaf fragments. The payload is additive so
 * an older client that only reads `data.html` keeps working.
 */
export type A2uiEventData =
  | { html: string }
  | { op: "createSurface"; surfaceId: string; html: string; nodeIds: string[] }
  | {
      op: "updateDataModel";
      surfaceId: string;
      fragments: Array<{ nodeId: string; html: string }>;
    };

/** Compile a `render_surface` tool result (`{ surfaceId, spec, dataModel }`) into a `createSurface` event. */
export function renderSurfaceEvent(result: ToolCallResult): A2uiEventData | null {
  if (!result.success) return null;
  const data = result.data as { surfaceId?: unknown; spec?: unknown; dataModel?: unknown };
  if (typeof data.surfaceId !== "string" || data.surfaceId.length === 0) return null;
  if (typeof data.spec !== "object" || data.spec === null) return null;
  const dataModel =
    typeof data.dataModel === "object" && data.dataModel !== null
      ? (data.dataModel as Record<string, unknown>)
      : {};
  const { html, nodeIds } = compileSurface(data.spec as A2uiSpec, dataModel);
  if (html.length === 0) return null;
  return { op: "createSurface", surfaceId: data.surfaceId, html, nodeIds };
}
