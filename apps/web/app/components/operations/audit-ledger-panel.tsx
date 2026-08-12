/**
 * The audit ledger's reader.
 *
 * Distinct from the "Recent operational activity" table above it, and the distinction is the whole
 * point: that one renders `ActivityService` entries — a best-effort UI feed where a lost row is
 * cosmetic — while these rows are hash-chained, append-only evidence that the runtime database
 * role cannot rewrite. Until this panel existed the ledger had no reader at all, so the only way
 * to answer "who repointed the Soul git remote" was `psql`.
 *
 * The chain badge is not decoration. A list view cannot show that a row was altered or removed;
 * only re-deriving every hash can, which is what `/api/v1/audit/verify` does.
 */

import { FileClock, ShieldCheck, ShieldX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import {
  type AuditEvent,
  type AuditVerifyReport,
  listAuditEvents,
  verifyAuditChain,
} from "~/lib/audit";
import { formatIso } from "~/lib/schema";

const PAGE_SIZE = 25;

function humanize(value: string): string {
  const words = value.replaceAll(/[._-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function ChainStatus({ report }: { report: AuditVerifyReport | null }) {
  if (!report) {
    return <StatusBadge label="Chain not checked" tone="neutral" />;
  }
  const tone: StatusTone = report.valid ? "success" : "danger";
  const Icon = report.valid ? ShieldCheck : ShieldX;
  return (
    <span className="flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5" />
      <StatusBadge
        tone={tone}
        label={
          report.valid
            ? `Chain intact · ${report.eventCount} events`
            : `Chain BROKEN · ${report.issues.length} issue(s)`
        }
      />
    </span>
  );
}

export function AuditLedgerPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [report, setReport] = useState<AuditVerifyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Verification is requested alongside the first page rather than behind a button: a broken
      // chain that nobody thought to check for is the same as no chain at all.
      const [page, verified] = await Promise.all([
        listAuditEvents(undefined, PAGE_SIZE),
        verifyAuditChain(),
      ]);
      setEvents(page.items);
      setCursor(page.nextCursor);
      setReport(verified);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the audit ledger");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    try {
      const page = await listAuditEvents(cursor, PAGE_SIZE);
      setEvents((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more audit events");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-md border border-border">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <FileClock aria-hidden="true" className="size-3.5" />
        <h2 className="text-xs font-medium">Audit ledger</h2>
        <span className="text-[0.625rem] text-muted-foreground">
          Append-only, hash-chained evidence
        </span>
        <span className="ml-auto flex items-center gap-2">
          <ChainStatus report={report} />
          <button
            type="button"
            onClick={() => void loadFirstPage()}
            disabled={loading}
            className="rounded-sm border border-border px-2 py-1 text-[0.625rem] hover:bg-muted disabled:opacity-50"
          >
            Re-verify
          </button>
        </span>
      </header>

      {error ? (
        <p className="px-3 py-4 text-xs text-destructive">{error}</p>
      ) : events.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {loading ? "Loading audit ledger…" : "No audit events recorded"}
        </p>
      ) : (
        <>
          <div className="max-w-full overflow-x-auto">
            <table aria-label="Audit ledger" className="w-full min-w-[52rem] text-left">
              <thead>
                <tr className="border-b border-border text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Actor</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium">Decision</th>
                  <th className="px-3 py-2 font-medium">Hash</th>
                  <th className="px-3 py-2 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((event) => (
                  <tr key={event.id} className="align-top">
                    <td className="px-3 py-2.5 text-[0.6875rem] text-muted-foreground">
                      {event.chainIndex}
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-xs font-medium">{humanize(event.action)}</p>
                      {event.reasonCodes.length > 0 ? (
                        <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
                          {event.reasonCodes.join(", ")}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{event.actorPrincipalId}</td>
                    <td className="px-3 py-2.5">
                      <code
                        title={event.target}
                        className="block max-w-48 truncate text-[0.6875rem]"
                      >
                        {event.target}
                      </code>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge
                        tone={event.decision === "allow" ? "success" : "danger"}
                        label={event.decision}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <code title={event.hash} className="text-[0.6875rem] text-muted-foreground">
                        {shortHash(event.hash)}
                      </code>
                    </td>
                    <td className="px-3 py-2.5 text-right text-[0.6875rem] text-muted-foreground">
                      {formatIso(event.occurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 border-t border-border px-3 py-2">
            <span className="text-[0.625rem] text-muted-foreground">
              Showing {events.length}
              {report ? ` of ${report.eventCount}` : ""} events
            </span>
            {cursor !== null ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loading}
                className="rounded-sm border border-border px-2 py-1 text-[0.625rem] hover:bg-muted disabled:opacity-50"
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
