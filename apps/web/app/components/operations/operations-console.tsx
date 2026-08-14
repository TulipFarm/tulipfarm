import { Link } from "@remix-run/react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  DatabaseBackup,
  Search,
  ShieldAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { DestructivePreview } from "~/components/shell/states";
import { StatusBadge as SemanticStatusBadge, type StatusTone } from "~/components/status-badge";
import type { OperationsModel } from "~/lib/operations";
import { formatIso } from "~/lib/schema";
import { cn } from "~/lib/utils";
import { AuditLedgerPanel } from "./audit-ledger-panel";

export type OperationAction =
  | "support-bundle.create"
  | "kill-switch.set"
  | "quarantine.resolve"
  | "recovery.start";

type OperationalItem = Record<string, unknown>;

function text(item: OperationalItem, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function humanize(value: string): string {
  const words = value.replaceAll(/[._-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function itemKey(item: OperationalItem, index: number): string {
  return text(item, "id", "component", "name") ?? `item-${index}`;
}

function statusValue(item: OperationalItem, fallback: string): string {
  const status = text(item, "status", "severity");
  if (status) return status;
  if (typeof item.enabled === "boolean") return item.enabled ? "enabled" : "disabled";
  return fallback;
}

function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (/critical|error|failed|high|blocked|enabled/.test(normalized)) return "danger";
  if (/degraded|warning|medium|pending|quarantined/.test(normalized)) return "warning";
  if (/ok|healthy|resolved|disabled|success|low/.test(normalized)) return "success";
  return "neutral";
}

function StatusBadge({ status }: { status: string }) {
  return <SemanticStatusBadge label={humanize(status)} tone={statusTone(status)} />;
}

function Section({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-xs font-medium uppercase tracking-[0.18em]">{title}</h2>
        {count === undefined ? null : (
          <span className="ml-auto text-[0.625rem] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-16 items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
      <CheckCircle2 aria-hidden="true" className="size-3.5 text-status-success" />
      <span>{children}</span>
    </div>
  );
}

function HealthPanel({ items }: { items: readonly OperationalItem[] }) {
  return (
    <Section
      title="Health"
      count={items.length}
      icon={<Activity aria-hidden="true" className="size-3.5" />}
    >
      {items.length === 0 ? (
        <EmptyPanel>No health checks reported</EmptyPanel>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item, index) => {
            const component = text(item, "component", "name", "id") ?? "Unknown component";
            const status = statusValue(item, "unknown");
            return (
              <li
                key={itemKey(item, index)}
                className="flex min-h-12 items-center gap-3 px-3 py-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={component}>
                  {component}
                </span>
                <StatusBadge status={status} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function IncidentsPanel({ items }: { items: readonly OperationalItem[] }) {
  return (
    <Section
      title="Incidents"
      count={items.length}
      icon={<AlertTriangle aria-hidden="true" className="size-3.5" />}
    >
      {items.length === 0 ? (
        <EmptyPanel>No active incidents</EmptyPanel>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item, index) => {
            const title = text(item, "title", "summary", "action", "id") ?? `Incident ${index + 1}`;
            const detail = text(item, "summary", "reason");
            const severity = statusValue(item, "open");
            const createdAt = text(item, "createdAt");
            return (
              <li key={itemKey(item, index)} className="px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-xs font-medium" title={title}>
                      {title}
                    </h3>
                    {detail && detail !== title ? (
                      <p className="mt-1 line-clamp-2 text-[0.6875rem] text-muted-foreground">
                        {detail}
                      </p>
                    ) : null}
                    {createdAt ? (
                      <time
                        dateTime={createdAt}
                        className="mt-1 block text-[0.625rem] text-muted-foreground"
                      >
                        {formatIso(createdAt)}
                      </time>
                    ) : null}
                  </div>
                  <StatusBadge status={severity} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function QuarantinePanel({ items }: { items: readonly OperationalItem[] }) {
  return (
    <Section
      title="Quarantine"
      count={items.length}
      icon={<ShieldAlert aria-hidden="true" className="size-3.5" />}
    >
      {items.length === 0 ? (
        <EmptyPanel>No quarantined items</EmptyPanel>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item, index) => {
            const id = text(item, "title", "name", "id") ?? `Item ${index + 1}`;
            const reason = text(item, "reason", "summary") ?? "Reason not provided";
            return (
              <li key={itemKey(item, index)} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={id}>
                    {id}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[0.6875rem] text-muted-foreground">
                    {reason}
                  </p>
                </div>
                <StatusBadge status={statusValue(item, "quarantined")} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/**
 * Deployment-level flags such as `HOOKS_DISABLED`. Named apart from the Kill switches panel above
 * it, which is the durable, operator-armed stop over mutating effects — during an incident two
 * panels reading "Kill switches" would be one ambiguity too many.
 */
function KillSwitchesPanel({ items }: { items: readonly OperationalItem[] }) {
  return (
    <Section
      title="Deployment flags"
      count={items.length}
      icon={<Ban aria-hidden="true" className="size-3.5" />}
    >
      {items.length === 0 ? (
        <EmptyPanel>No deployment flags set</EmptyPanel>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item, index) => {
            const id = text(item, "name", "id") ?? `Switch ${index + 1}`;
            const scope = text(item, "scope", "summary");
            return (
              <li key={itemKey(item, index)} className="flex min-h-12 items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={id}>
                    {humanize(id)}
                  </p>
                  {scope ? (
                    <p className="mt-0.5 truncate text-[0.625rem] text-muted-foreground">{scope}</p>
                  ) : null}
                </div>
                <StatusBadge status={statusValue(item, "unknown")} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function compactIdentifier(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

const ACTIVITY_PREVIEW_LIMIT = 8;
const ACTIVITY_SEARCH_KEYS = [
  "action",
  "event",
  "summary",
  "title",
  "actorName",
  "actorType",
  "targetType",
  "targetId",
  "target",
  "status",
] as const;

function matchesActivityQuery(item: OperationalItem, query: string): boolean {
  if (!query) return true;
  return ACTIVITY_SEARCH_KEYS.some((key) => text(item, key)?.toLowerCase().includes(query));
}

function OperationalActivityTable({ items }: { items: readonly OperationalItem[] }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matchingItems = items.filter((item) => matchesActivityQuery(item, normalizedQuery));
  const visibleItems = matchingItems.slice(0, ACTIVITY_PREVIEW_LIMIT);

  return (
    <Section
      title="Recent operational activity"
      count={items.length}
      icon={<ShieldAlert aria-hidden="true" className="size-3.5" />}
    >
      {items.length === 0 ? (
        <EmptyPanel>No operational activity recorded</EmptyPanel>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <label className="relative min-w-48 flex-1 sm:max-w-xs">
              <span className="sr-only">Filter operational activity</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Filter recent activity"
                className="h-8 w-full rounded-sm border border-border bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
              />
            </label>
            <span className="text-[0.625rem] text-muted-foreground">
              Showing {visibleItems.length} of {items.length} events
            </span>
            <Link
              to="/business/activities"
              className="ml-auto text-xs text-primary underline-offset-2 hover:underline"
            >
              View all activities
            </Link>
          </div>
          {visibleItems.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              No matching operational activity
            </div>
          ) : (
            <div className="max-w-full overflow-x-auto">
              <table
                aria-label="Recent operational activity"
                className="w-full min-w-[46rem] text-left"
              >
                <thead>
                  <tr className="border-b border-border text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                    <th className="w-[42%] px-3 py-2 font-medium">Event</th>
                    <th className="px-3 py-2 font-medium">Actor</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleItems.map((item, index) => {
                    const action = text(item, "action", "event") ?? "Activity";
                    const summary = text(item, "summary", "title") ?? humanize(action);
                    const actor = text(item, "actorName", "actorType", "actorId") ?? "system";
                    const targetType = text(item, "targetType");
                    const targetId = text(item, "targetId", "target");
                    const status = statusValue(item, "recorded");
                    const createdAt = text(item, "createdAt");
                    return (
                      <tr key={itemKey(item, index)} className="align-top">
                        <td className="px-3 py-2.5">
                          <p className="max-w-xl text-xs font-medium">{summary}</p>
                          <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
                            {humanize(action)}
                          </p>
                        </td>
                        <td className="px-3 py-2.5 text-xs">{humanize(actor)}</td>
                        <td className="px-3 py-2.5 text-xs">
                          {targetType ? (
                            <span className="block text-[0.625rem] text-muted-foreground">
                              {humanize(targetType)}
                            </span>
                          ) : null}
                          {targetId ? (
                            <code
                              title={targetId}
                              className="block max-w-36 truncate text-[0.6875rem] text-foreground"
                            >
                              {compactIdentifier(targetId)}
                            </code>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status={status} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right text-[0.6875rem] text-muted-foreground">
                          {createdAt ? (
                            <time dateTime={createdAt}>{formatIso(createdAt)}</time>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function attentionItems(model: OperationsModel): number {
  const unhealthy = model.health.filter(
    (item) => statusTone(statusValue(item, "unknown")) !== "success"
  ).length;
  const activeKillSwitches = model.killSwitches.filter(
    (item) => statusTone(statusValue(item, "unknown")) !== "success"
  ).length;
  return unhealthy + model.incidents.length + model.quarantine.length + activeKillSwitches;
}

export function OperationsConsole({
  model,
  busy = false,
  onCommand,
}: {
  model: OperationsModel;
  busy?: boolean;
  onCommand: (action: OperationAction, input: Record<string, unknown>) => void;
}) {
  const [previewSupport, setPreviewSupport] = useState(false);
  const attentionCount = attentionItems(model);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Operations</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Authorized operational summaries. Protected payloads remain redacted.
          </p>
          <p
            role="status"
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 text-xs",
              attentionCount > 0 ? "text-status-warning" : "text-status-success"
            )}
          >
            {attentionCount > 0 ? (
              <AlertTriangle aria-hidden="true" className="size-3.5" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
            )}
            {attentionCount > 0
              ? `${attentionCount} item${attentionCount === 1 ? "" : "s"} need attention`
              : "All reported systems operational"}
          </p>
        </div>
        {model.recovery.supportBundleAvailable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setPreviewSupport(true)}
            className="ml-auto rounded-sm border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
          >
            Create support bundle
          </button>
        ) : null}
      </header>

      {previewSupport ? (
        <DestructivePreview
          action="Create Support Bundle"
          target="redacted operational diagnostics"
          destination="authorized support bundle Artifact"
          reversibility="Bundle creation is audited; the immutable Artifact can expire by retention"
          busy={busy}
          onCancel={() => setPreviewSupport(false)}
          onConfirm={() => {
            setPreviewSupport(false);
            onCommand("support-bundle.create", {});
          }}
        />
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <HealthPanel items={model.health} />
        <IncidentsPanel items={model.incidents} />
        <QuarantinePanel items={model.quarantine} />
        <KillSwitchesPanel items={model.killSwitches} />
      </div>

      <OperationalActivityTable items={model.activity} />

      <AuditLedgerPanel />

      <Section title="Recovery" icon={<DatabaseBackup aria-hidden="true" className="size-3.5" />}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-3 text-xs">
          <div>
            <span className="text-muted-foreground">Last backup</span>
            <p className="mt-0.5 font-medium">
              {model.recovery.lastBackupAt
                ? formatIso(model.recovery.lastBackupAt)
                : "No backup reported"}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Support bundle</span>
            <p className="mt-0.5 font-medium">
              {model.recovery.supportBundleAvailable ? "Available" : "Unavailable"}
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
