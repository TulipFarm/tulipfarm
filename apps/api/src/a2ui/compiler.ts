/**
 * A2UI spec compiler — turns a declarative spec (spec.ts) + a data model into `tf-*` HTML for the
 * sandboxed iframe. This is the server-authoritative binding engine: `{path}` leaves are resolved
 * against the data model here, so the iframe stays a dumb renderer. Every node is stamped with a
 * stable `data-a2ui-id` (the fragment-swap anchor used by `updateComponents`/`updateDataModel`).
 *
 * Unknown components are skipped (the agent's spec degrades gracefully, mirroring how the iframe
 * sanitizer drops unknown `tf-*` tags) rather than throwing — a malformed branch never breaks the
 * surface. All agent-controlled values are HTML-escaped via the catalog's `ctx.text`.
 */

import { A2UI_CATALOG, type CompileCtx } from "./catalog";
import { esc } from "./escape";
import type { A2uiDataModel, A2uiNode, A2uiSpec } from "./spec";

function isBinding(v: unknown): v is { path: string } {
  return typeof v === "object" && v !== null && typeof (v as { path?: unknown }).path === "string";
}

/** Resolve a JSON-pointer-ish path (`/a/b`, with `~1`→`/`, `~0`→`~`) against the data model. */
function resolvePath(model: unknown, path: string): unknown {
  if (path.length === 0) return undefined;
  let cur: unknown = model;
  for (const seg of path.split("/")) {
    if (seg.length === 0) continue;
    if (cur === null || typeof cur !== "object") return undefined;
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function resolveValue(v: unknown, model: A2uiDataModel): unknown {
  return isBinding(v) ? resolvePath(model, v.path) : v;
}

function toText(resolved: unknown): string {
  if (resolved === null || resolved === undefined) return "";
  if (typeof resolved === "string") return resolved;
  if (typeof resolved === "number" || typeof resolved === "boolean") return String(resolved);
  return JSON.stringify(resolved);
}

/** A compiled node: its id, full `outerHTML`, and whether it's a leaf (no A2uiNode children). */
export interface CompiledNode {
  id: string;
  html: string;
  leaf: boolean;
}

export interface CompiledSurface {
  html: string;
  nodeIds: string[];
  /**
   * Every node's compiled `outerHTML`, in post-order. Live updates (updateDataModel) recompile and
   * diff the LEAF fragments by id — containers carry no bound props (only children), so a binding
   * change always lands on a leaf, and swapping that leaf in place updates its ancestor's DOM too.
   */
  nodes: CompiledNode[];
}

const CONTAINER_COMPONENTS = new Set<A2uiNode["component"]>(["Card", "Row", "Column", "Grid"]);

/** Compile a spec + data model to `tf-*` HTML, resolving `{path}` bindings server-side. */
export function compileSurface(spec: A2uiSpec, dataModel: A2uiDataModel = {}): CompiledSurface {
  const nodeIds: string[] = [];
  const nodes: CompiledNode[] = [];
  let counter = 0;

  const ctx: CompileCtx = {
    text: (v) => esc(toText(resolveValue(v, dataModel))),
    raw: (v) => resolveValue(v, dataModel),
    children: (nodes) => (nodes ?? []).map(renderNode).join(""),
  };

  function renderNode(node: A2uiNode): string {
    const entry = A2UI_CATALOG[node.component];
    if (!entry) return "";
    const id = node.id ?? `a2-${counter++}`;
    nodeIds.push(id);
    const html = entry(node, ctx, ` data-a2ui-id="${esc(id)}"`);
    nodes.push({ id, html, leaf: !CONTAINER_COMPONENTS.has(node.component) });
    return html;
  }

  const roots = Array.isArray(spec.root) ? spec.root : [spec.root];
  const html = roots.map(renderNode).join("");
  return { html, nodeIds, nodes };
}
