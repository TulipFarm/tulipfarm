/**
 * A2UI postMessage envelope contract — the single source of truth shared by the parent bridge
 * (a2ui-frame.tsx) and the in-iframe runtime (runtime.ts). `parseMessage` is the structural gate:
 * only well-formed, structured-clone data is allowed to cross the sandbox boundary, and payloads
 * are never trusted as code.
 */

export type A2uiChannel = "agent" | "api" | "navigate";

/** frame → host; relayed to host callbacks (onAgent / onApi / onNavigate). */
export interface A2uiMessage {
  channel: A2uiChannel;
  payload: unknown;
}

/** frame → host; handled internally by the component, not the host. */
export type A2uiInternal = { __a2ui: "resize"; height: number } | { __a2ui: "ready" };

/**
 * host → frame; applied directly by the in-iframe runtime as a DOM swap (replace each node carrying
 * `data-a2ui-id` with the compiled fragment), NOT relayed to components. Fragment HTML is sanitised
 * parent-side before send (the CSP'd frame can't run DOMPurify). Powers `updateComponents` /
 * `updateDataModel` live surface updates without rebuilding the iframe.
 */
export type A2uiSwap = { __a2ui: "swap"; fragments: Array<{ nodeId: string; html: string }> };

const CHANNELS: readonly A2uiChannel[] = ["agent", "api", "navigate"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a typed message, an internal message, or null for anything malformed. */
export function parseMessage(data: unknown): A2uiMessage | A2uiInternal | null {
  if (!isRecord(data)) return null;

  if ("__a2ui" in data) {
    if (data.__a2ui === "ready") return { __a2ui: "ready" };
    if (data.__a2ui === "resize" && typeof data.height === "number") {
      return { __a2ui: "resize", height: data.height };
    }
    return null;
  }

  const { channel } = data;
  const known = typeof channel === "string" && (CHANNELS as readonly string[]).includes(channel);
  if (known && "payload" in data) {
    return { channel: channel as A2uiChannel, payload: data.payload };
  }
  return null;
}
