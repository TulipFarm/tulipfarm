import type { A2uiSurfaceStore } from "../a2ui/artifact-surface";
import { compileSurface } from "../a2ui/compiler";
import type { A2uiDataModel, A2uiSpec } from "../a2ui/spec";
import type { ToolCallResult } from "../tools/types";
import { type A2uiEventData, renderA2uiHtml, renderSurfaceEvent } from "./a2ui-render";

/**
 * Stateful A2UI surface orchestration on top of the pure compiler/render (a2ui-render.ts). Maps a
 * view/terminal tool result to the `a2ui` SSE events the producer emits, AND keeps the surface store
 * current so live updates work:
 *  - `render_surface` / `ask_user` → a `createSurface` event + persist {spec, dataModel} for the surface.
 *  - `update_surface` → load the surface, merge the data-model patch, recompile, diff the changed LEAF
 *     fragments, persist the new data model, and emit an `updateDataModel` event the iframe swaps in place.
 *  - legacy view tools → a `{ html }` event.
 */
export interface A2uiSurfaceCtx {
  store?: A2uiSurfaceStore;
  conversationId?: string;
}

/** Compile the surface and index every LEAF node's `outerHTML` by id (the diff/swap unit). */
function leafFragments(spec: A2uiSpec, dataModel: A2uiDataModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of compileSurface(spec, dataModel).nodes) {
    if (node.leaf) map.set(node.id, node.html);
  }
  return map;
}

async function surfaceUpdateEvents(
  data: Record<string, unknown>,
  ctx: A2uiSurfaceCtx
): Promise<A2uiEventData[]> {
  const { store, conversationId } = ctx;
  const surfaceId = data.surfaceId;
  if (!store || !conversationId || typeof surfaceId !== "string") return [];
  const surface = await store.get(conversationId, surfaceId);
  if (!surface) return []; // nothing rendered yet for this id — no-op

  const patch =
    typeof data.dataModel === "object" && data.dataModel !== null
      ? (data.dataModel as A2uiDataModel)
      : {};
  const nextDataModel = { ...surface.dataModel, ...patch };

  const before = leafFragments(surface.spec, surface.dataModel);
  const after = leafFragments(surface.spec, nextDataModel);
  const fragments: Array<{ nodeId: string; html: string }> = [];
  for (const [id, html] of after) {
    if (before.get(id) !== html) fragments.push({ nodeId: id, html });
  }

  await store.upsert(conversationId, surfaceId, surface.spec, nextDataModel);
  return fragments.length > 0 ? [{ op: "updateDataModel", surfaceId, fragments }] : [];
}

/** The `a2ui` events to emit for a tool result (and the surface-store side effects they imply). */
export async function a2uiEventsForToolResult(
  toolName: string,
  result: ToolCallResult,
  ctx: A2uiSurfaceCtx = {}
): Promise<A2uiEventData[]> {
  if (toolName === "update_surface") {
    return result.success ? surfaceUpdateEvents(result.data as Record<string, unknown>, ctx) : [];
  }
  if (toolName === "render_surface" || toolName === "ask_user") {
    const event = renderSurfaceEvent(result);
    if (event && result.success && ctx.store && ctx.conversationId) {
      const d = result.data as { surfaceId: string; spec: A2uiSpec; dataModel?: A2uiDataModel };
      await ctx.store.upsert(ctx.conversationId, d.surfaceId, d.spec, d.dataModel ?? {});
    }
    return event ? [event] : [];
  }
  const html = renderA2uiHtml(toolName, result);
  return html ? [{ html }] : [];
}
