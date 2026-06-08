import { Link, type MetaFunction } from "@remix-run/react";
import { useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  type ScanResult,
  type SkillAuditReport,
  auditSkill,
  installSkills,
  scanSkills,
} from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Install skill · tulipfarm" }];

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const RISK_CLASS: Record<SkillAuditReport["riskRating"], string> = {
  low: "border-border text-muted-foreground",
  medium: "border-primary text-primary",
  high: "border-destructive text-destructive",
};

const SEVERITY_CLASS: Record<SkillAuditReport["findings"][number]["severity"], string> = {
  info: "text-muted-foreground",
  warning: "text-primary",
  critical: "text-destructive",
};

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "request failed";
}

function AuditReportCard({ name, report }: { name: string; report: SkillAuditReport }) {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{name}</span>
        <span
          className={`ml-auto rounded-sm border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] ${RISK_CLASS[report.riskRating]}`}
        >
          {report.riskRating} risk
        </span>
      </div>
      <p className="text-muted-foreground">{report.summary}</p>
      {report.toolsReach.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="uppercase tracking-[0.15em]">tool reach:</span>{" "}
          {report.toolsReach.join(", ")}
        </p>
      ) : null}
      {report.findings.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {report.findings.map((f, i) => (
            <li key={`${f.category}-${i}`} className="flex gap-2">
              <span aria-hidden className={SEVERITY_CLASS[f.severity]}>
                ◆
              </span>
              <span className="text-muted-foreground">
                <span className="text-foreground">{f.category}</span> — {f.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No specific findings.</p>
      )}
    </div>
  );
}

export default function SkillInstall() {
  const [source, setSource] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<Record<string, SkillAuditReport>>({});
  const [busy, setBusy] = useState<null | "scan" | "audit" | "install">(null);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);

  const selectedNames = [...selected];
  const allAudited = selectedNames.length > 0 && selectedNames.every((n) => reports[n]);

  async function onScan() {
    if (!source.trim()) return;
    setBusy("scan");
    setError(null);
    setReports({});
    setInstalled(null);
    // Clear any prior scan so stale results aren't shown/interactive during the new scan.
    setScan(null);
    setSelected(new Set());
    try {
      const result = await scanSkills(source.trim());
      setScan(result);
      setSelected(new Set(result.skills.map((s) => s.name)));
    } catch (e) {
      setScan(null);
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function onAudit() {
    if (!scan || selectedNames.length === 0) return;
    setBusy("audit");
    setError(null);
    // Audit each selected skill independently so one failure does not discard the others' reports.
    const settled = await Promise.allSettled(
      selectedNames.map((name) => auditSkill(scan.scanId, name))
    );
    const next: Record<string, SkillAuditReport> = {};
    const failures: string[] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") next[selectedNames[i]] = result.value;
      else failures.push(`${selectedNames[i]}: ${errMessage(result.reason)}`);
    });
    setReports(next);
    setError(failures.length > 0 ? failures.join("; ") : null);
    setBusy(null);
  }

  async function onInstall() {
    if (!scan || !allAudited) return;
    setBusy("install");
    setError(null);
    try {
      const res = await installSkills(scan.scanId, selectedNames);
      setInstalled(res.installed);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ResourcePanel
      crumbs={[{ label: "skills", to: "/skills" }, { label: "install" }]}
      command="tulipfarm skills install --from-git"
    >
      {error ? (
        <p className="rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-destructive">
          error: {error}
        </p>
      ) : null}

      {installed ? (
        <div className="flex flex-col gap-3">
          <p className="text-foreground">
            <span aria-hidden className="text-primary">
              ✓{" "}
            </span>
            Installed {installed.join(", ")}.
          </p>
          <Button asChild size="sm" className="self-start">
            <Link to="/skills">Back to skills</Link>
          </Button>
        </div>
      ) : (
        <>
          {/* Step 1 — scan a git repo for installable skills. */}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void onScan();
            }}
          >
            <label
              htmlFor="source"
              className="text-xs uppercase tracking-[0.2em] text-muted-foreground"
            >
              git url
            </label>
            <div className="flex gap-2">
              <input
                id="source"
                className={inputClass}
                placeholder="https://github.com/owner/repo  or  owner/repo"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={busy !== null}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !source.trim()}>
                {busy === "scan" ? "Scanning…" : "Scan"}
              </Button>
            </div>
          </form>

          {/* Step 2 — pick which discovered skills to review. */}
          {scan ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                {scan.skills.length} discovered — select skills to review
              </p>
              <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
                {scan.skills.map((s) => (
                  <li key={s.name}>
                    <label className="flex cursor-pointer items-baseline gap-2 px-3 py-2 hover:bg-accent">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={selected.has(s.name)}
                        onChange={() => toggle(s.name)}
                        disabled={busy !== null}
                      />
                      <span className="font-medium text-foreground">{s.name}</span>
                      {s.description ? (
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {s.description}
                        </span>
                      ) : null}
                      {reports[s.name] ? (
                        <span
                          className={`ml-auto shrink-0 rounded-sm border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] ${RISK_CLASS[reports[s.name].riskRating]}`}
                        >
                          {reports[s.name].riskRating}
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => void onAudit()}
                disabled={busy !== null || selectedNames.length === 0}
              >
                {busy === "audit" ? "Auditing…" : `Run SkillAudit (${selectedNames.length})`}
              </Button>
            </div>
          ) : null}

          {/* Step 3 — advisory reports + explicit operator confirm. */}
          {allAudited ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              {selectedNames.map((name) => (
                <AuditReportCard key={name} name={name} report={reports[name]} />
              ))}
              <p className="rounded-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                SkillAudit is <span className="text-foreground">advisory, not a guarantee</span>. A
                skill is natural-language instruction and cannot be sandboxed — it may read benign
                yet behave badly in context, and injection can be obscured. Installed skills run
                with full tool access (no per-skill ACL in V1). Confirming installs these skills
                into your soul repo.
              </p>
              <Button
                size="sm"
                className="self-start"
                onClick={() => void onInstall()}
                disabled={busy !== null}
              >
                {busy === "install" ? "Installing…" : `Confirm install (${selectedNames.length})`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ResourcePanel>
  );
}
