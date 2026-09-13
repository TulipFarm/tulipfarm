import { isRecord } from "@tulipfarm/schema/guards";
import type { SourceRef, ToolPreview } from "~/lib/chat/types";

function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    if (value.startsWith("/")) {
      const origin = "https://citation.invalid";
      const url = new URL(value, origin);
      return !value.startsWith("//") && !url.pathname.startsWith("//") && url.origin === origin
        ? `${url.pathname}${url.search}${url.hash}`
        : undefined;
    }
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function sourceFrom(value: unknown): SourceRef | undefined {
  if (!isRecord(value) || !Number.isInteger(value.ref) || Number(value.ref) < 1) return undefined;
  const url = safeSourceUrl(value.url);
  const title = typeof value.title === "string" && value.title.length > 0 ? value.title : undefined;
  const path = typeof value.path === "string" && value.path.length > 0 ? value.path : undefined;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
  if (url === undefined && title === undefined && path === undefined && id === undefined) {
    return undefined;
  }
  return {
    ref: Number(value.ref),
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(path === undefined ? {} : { path }),
    ...(id === undefined ? {} : { id }),
  };
}

/** Extract participant-safe citations from an authorized Tool result shape. */
export function sourcesFromToolResult(value: unknown): SourceRef[] {
  if (!isRecord(value)) return [];
  const data = isRecord(value.data) ? value.data : value;
  const raw = Array.isArray(data.sources) ? data.sources : data.citations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((source) => {
    const parsed = sourceFrom(source);
    return parsed === undefined ? [] : [parsed];
  });
}

export function sourcesFromToolPreview(preview: ToolPreview | undefined): SourceRef[] {
  if (preview === undefined) return [];
  try {
    return sourcesFromToolResult(JSON.parse(preview.json));
  } catch {
    return [];
  }
}
