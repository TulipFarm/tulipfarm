import { isRecord } from "@tulipfarm/schema/guards";
import { useMemo } from "react";
import { Link } from "~/components/ui/link";
import type { TimelinePart } from "~/lib/chat/types";
import { recordLabel } from "~/lib/schema";
import { parsedArgs, parsedResult } from "./tool-inspector";

type ResourceChange = {
  path: string;
  label: string;
  action: string;
  resourceType?: string;
  deleted?: boolean;
};

const RESOURCE_NAME = /^[a-z][a-z0-9-]*$/;
const RECORD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const WRITE_TOOLS = new Set([
  "create_resource_type",
  "update_resource_type",
  "record_create",
  "record_update",
  "record_delete",
]);

function changesFrom(parts: readonly TimelinePart[]): ResourceChange[] {
  const changes = new Map<string, ResourceChange>();
  for (const part of parts) {
    if (
      part.kind !== "tool" ||
      !WRITE_TOOLS.has(part.toolName) ||
      part.status !== "done" ||
      part.outcome === "error" ||
      part.meta?.errorCode !== undefined ||
      !(part.outcome === "ok" || (isRecord(part.result) && part.result.status === "ok")) ||
      [part.argsPreview, part.resultPreview].some(
        (preview) => preview?.truncated || (preview?.redactedPaths?.length ?? 0) > 0
      )
    ) {
      continue;
    }
    const args = parsedArgs(part);
    const value = parsedResult(part);
    const result =
      part.resultPreview === undefined &&
      isRecord(value) &&
      value.status === "ok" &&
      typeof value.id !== "string" &&
      isRecord(value.data)
        ? value.data
        : value;
    if (!isRecord(result)) continue;

    if (part.toolName === "create_resource_type" || part.toolName === "update_resource_type") {
      if (typeof result.name !== "string" || !RESOURCE_NAME.test(result.name)) continue;
      const path = `/resources/${encodeURIComponent(result.name)}/schema`;
      changes.set(path, {
        path,
        label: result.name,
        action:
          part.toolName === "create_resource_type" ? "Created resource type" : "Updated schema",
      });
      continue;
    }

    if (
      !isRecord(args) ||
      typeof args.type !== "string" ||
      !RESOURCE_NAME.test(args.type) ||
      typeof result.id !== "string" ||
      !RECORD_ID.test(result.id)
    ) {
      continue;
    }
    const deleted = part.toolName === "record_delete";
    if (!deleted && !(typeof result.version === "number" && result.version > 0)) continue;
    const path = `/resources/${encodeURIComponent(args.type)}/${encodeURIComponent(result.id)}`;
    changes.set(path, {
      path,
      label: deleted ? (changes.get(path)?.label ?? result.id) : recordLabel(result),
      resourceType: args.type,
      deleted,
      // A successful create may return an existing Record after an idempotent replay.
      action: deleted
        ? "Deleted record"
        : part.toolName === "record_create"
          ? "Saved record"
          : "Updated record",
    });
  }
  return [...changes.values()];
}

export function ResourceChanges({ parts }: { parts: readonly TimelinePart[] }) {
  const changes = useMemo(() => changesFrom(parts), [parts]);
  if (changes.length === 0) return null;
  return (
    <section aria-label="Resource changes" className="mt-2 min-w-0">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">Resource changes</h2>
      <ul className="space-y-2 sm:space-y-0">
        {changes.map((change) => (
          <li
            key={change.path}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
          >
            <span className="text-muted-foreground">{change.action}</span>
            {change.deleted ? (
              <span className="py-1 [overflow-wrap:anywhere]">{change.label}</span>
            ) : (
              <Link
                to={change.path}
                className="inline-flex min-h-11 min-w-0 items-center text-brand hover:underline sm:min-h-6"
              >
                <span className="[overflow-wrap:anywhere]">{change.label}</span>
              </Link>
            )}
            {change.resourceType ? (
              <span className="text-muted-foreground [overflow-wrap:anywhere]">
                {change.resourceType}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
