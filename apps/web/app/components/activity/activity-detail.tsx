import { CopyField } from "~/components/ui/copy-field";
import { ReadonlyField } from "~/components/ui/field";
import type { ActivityEntry } from "~/lib/activity-feed";
import { EntryBadge } from "./entry-badge";
import { formatFull } from "./presentation";

/**
 * Everything the log recorded about one entry. A Run is deliberately absent — it drills into its
 * own inspector, which can control the Run where a read-only panel could not.
 */
export function ActivityDetail({ entry }: { entry: ActivityEntry }) {
  const activity = entry.activity;
  if (activity === undefined) return null;
  const hasMetadata = Object.keys(activity.metadata).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <EntryBadge entry={entry} />
        <time dateTime={entry.at} className="text-xs tabular-nums text-muted-foreground">
          {formatFull(entry.at)}
        </time>
      </div>

      <dl className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <ReadonlyField label="Action">
            <code className="font-mono text-xs">{activity.action}</code>
          </ReadonlyField>
          <ReadonlyField label="Category">{activity.category}</ReadonlyField>
          <ReadonlyField label="Actor">
            {activity.actorType === "system"
              ? "System"
              : (activity.actorId ?? "A signed-in person")}
          </ReadonlyField>
          <ReadonlyField label="Target">{activity.targetType ?? "None"}</ReadonlyField>
        </div>

        {activity.targetId ? (
          <ReadonlyField label="Target id">
            <CopyField value={activity.targetId} label="target id" className="mt-1" />
          </ReadonlyField>
        ) : null}

        {hasMetadata ? (
          <ReadonlyField label="Recorded details">
            <pre className="mt-1 overflow-x-auto rounded-md border border-code-border bg-code-surface p-3 font-mono text-xs">
              {JSON.stringify(activity.metadata, null, 2)}
            </pre>
          </ReadonlyField>
        ) : null}
      </dl>
    </div>
  );
}
