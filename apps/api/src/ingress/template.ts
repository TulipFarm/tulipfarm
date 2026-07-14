import type { BodyMatch } from "@tulipfarm/soul";

/**
 * Tiny declarative templating shared by the ingress engine. Two flavors, both `{…}` delimited:
 * body templates resolve dot-paths into the webhook payload (with `|` fallbacks), var templates
 * substitute from a flat map the caller assembled. No expressions, no sandbox — hot-path safe.
 */

/** Resolve a dot-path ("event.channel") into a nested object; undefined when any hop is missing. */
export function dotPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Render "{team_id}/{event.thread_ts|event.ts}"-style templates over the payload. */
export function renderBodyTemplate(template: string, body: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    for (const path of expr.split("|")) {
      const value = dotPath(body, path.trim());
      if (value !== undefined && value !== null) return String(value);
    }
    return "";
  });
}

/** Dot-path equality match; an absent match config always passes. */
export function matchesBody(body: Record<string, unknown>, match?: BodyMatch): boolean {
  if (!match) return true;
  const value = dotPath(body, match.path);
  return value !== undefined && value !== null && String(value) === match.equals;
}

/** Render tool-binding arg templates ("{channel}", "{text}") from a flat var map. */
export function renderVarTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => vars[name.trim()] ?? "");
}
