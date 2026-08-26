import { Link, type MetaFunction, useLoaderData } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { SkillsTabs } from "~/components/skills-tabs";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  auditSkill,
  installSkills,
  type MarketplaceCatalog,
  marketplaceSkills,
  type ScannedSkill,
  type ScanResult,
  type SkillAuditReport,
  type SkillInstallStatus,
  scanSkills,
  skillRowKey,
} from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Marketplace · tulipfarm" }];

// Status pill for a discovered/catalog skill: stale installs surface an update, current installs read
// as installed, and not-yet-installed skills get no pill (install happens via the review pipeline).
function InstallBadge({ installed, updateAvailable }: SkillInstallStatus) {
  if (updateAvailable) {
    return (
      <span className="shrink-0 rounded-sm border border-primary px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-primary">
        update available
      </span>
    );
  }
  if (installed) {
    return (
      <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
        installed ✓
      </span>
    );
  }
  return null;
}

// The official catalog is a nicety — when the marketplace repo is unreachable the manual git-URL
// scan must still work, so failures collapse to `null` instead of breaking the page.
export async function clientLoader() {
  return { catalog: await marketplaceSkills().catch(() => null) };
}

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

const GUARD_SEVERITY_CLASS: Record<
  SkillAuditReport["deterministicScan"]["findings"][number]["severity"],
  string
> = {
  low: "border-border text-muted-foreground",
  medium: "border-border text-foreground",
  high: "border-primary text-primary",
  critical: "border-destructive text-destructive",
};

/**
 * The findings worth stopping an operator on. These used to make the API refuse the package
 * outright; now they install if the operator says so, which is only defensible if the operator
 * cannot miss them.
 */
function severeFindings(
  report: SkillAuditReport | undefined
): SkillAuditReport["deterministicScan"]["findings"] {
  if (!report) return [];
  return report.deterministicScan.findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high"
  );
}

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "request failed";
}

function AuditReportCard({ name, report }: { name: string; report: SkillAuditReport }) {
  const guardGroups = new Map<string, SkillAuditReport["deterministicScan"]["findings"]>();
  for (const finding of report.deterministicScan.findings) {
    const group = guardGroups.get(finding.category);
    if (group) group.push(finding);
    else guardGroups.set(finding.category, [finding]);
  }

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
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-[0.15em] text-foreground">
            Deterministic pre-scan
          </span>
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
            {report.deterministicScan.verdict}
          </span>
          <span className="text-xs text-muted-foreground">
            {report.deterministicScan.trustLevel} source
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Advisory scanner evidence is shown verbatim and never blocks the operator’s choice.
        </p>
        {guardGroups.size > 0 ? (
          [...guardGroups].map(([category, findings]) => (
            <section key={category} className="flex flex-col gap-1">
              <h3 className="text-xs uppercase tracking-[0.15em] text-foreground">{category}</h3>
              <ul className="flex flex-col gap-2">
                {findings.map((finding) => (
                  <li
                    key={`${finding.patternId}-${finding.file}-${finding.line}`}
                    className="rounded-sm border border-border p-2 text-xs text-muted-foreground"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-sm border px-1.5 py-0.5 uppercase tracking-[0.15em] ${GUARD_SEVERITY_CLASS[finding.severity]}`}
                      >
                        {finding.severity}
                      </span>
                      <span className="text-foreground">{finding.patternId}</span>
                      <span>
                        {finding.file}:{finding.line}
                      </span>
                    </div>
                    <p className="mt-1">{finding.description}</p>
                    <code className="mt-1 block whitespace-pre-wrap break-all text-foreground">
                      {finding.match}
                    </code>
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No deterministic patterns or structural anomalies found.
          </p>
        )}
      </div>
    </div>
  );
}

export default function SkillsMarketplace() {
  const { catalog } = useLoaderData<typeof clientLoader>() as {
    catalog: MarketplaceCatalog | null;
  };
  const [source, setSource] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<Record<string, SkillAuditReport>>({});
  const [busy, setBusy] = useState<null | "scan" | "audit" | "install">(null);
  const [error, setError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const installErrorRef = useRef<HTMLParagraphElement>(null);

  // Selection, reports and the install payload are all keyed by row, never by name: a source may
  // define two different skills with the same name, and merging them silently swaps one package
  // for another between what the operator reviewed and what is written to the soul.
  const selectedSkills = (scan?.skills ?? []).filter((s) => selected.has(skillRowKey(s)));
  const allAudited =
    selectedSkills.length > 0 && selectedSkills.every((s) => reports[skillRowKey(s)]);
  const severeSelected = selectedSkills.flatMap((s) =>
    severeFindings(reports[skillRowKey(s)]).map((finding) => ({ skillName: s.name, finding }))
  );
  const catalogGroups = new Map<string, MarketplaceCatalog["skills"]>();
  for (const skill of catalog?.skills ?? []) {
    const category = skill.category ?? "other";
    const group = catalogGroups.get(category);
    if (group) group.push(skill);
    else catalogGroups.set(category, [skill]);
  }
  const updateCount = catalog?.skills.filter((skill) => skill.updateAvailable).length ?? 0;

  // The report list is long, so an error rendered beside the confirm button can still be off
  // screen. Focus scrolls it into view and announces it at the point of failure (#444).
  useEffect(() => {
    if (installError) installErrorRef.current?.focus();
  }, [installError]);

  // Load one or more catalog skills into the select → audit → confirm pipeline (the audit gate runs
  // unchanged). Used by the per-row Install/Update buttons and the "Review all" button.
  function loadIntoPipeline(scanId: string, skills: ScannedSkill[]) {
    setError(null);
    setInstallError(null);
    setReports({});
    setInstalled(null);
    setScan({ scanId, skills });
    setSelected(new Set(skills.map(skillRowKey)));
  }

  async function onScan() {
    if (!source.trim()) return;
    setBusy("scan");
    setError(null);
    setInstallError(null);
    setReports({});
    setInstalled(null);
    // Clear any prior scan so stale results aren't shown/interactive during the new scan.
    setScan(null);
    setSelected(new Set());
    try {
      const result = await scanSkills(source.trim());
      setScan(result);
      setSelected(new Set(result.skills.map(skillRowKey)));
    } catch (e) {
      setScan(null);
      setError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onAudit() {
    if (!scan || selectedSkills.length === 0) return;
    setBusy("audit");
    setError(null);
    setInstallError(null);
    // Audit each selected skill independently so one failure does not discard the others' reports.
    const settled = await Promise.allSettled(
      selectedSkills.map((s) => auditSkill(scan.scanId, s.name, s.skillPath))
    );
    const next: Record<string, SkillAuditReport> = {};
    const failures: string[] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") next[skillRowKey(selectedSkills[i])] = result.value;
      else failures.push(`${selectedSkills[i].name}: ${errMessage(result.reason)}`);
    });
    setReports(next);
    setError(failures.length > 0 ? failures.join("; ") : null);
    setBusy(null);
  }

  async function onInstall() {
    if (!scan || !allAudited) return;
    setBusy("install");
    setError(null);
    setInstallError(null);
    try {
      const res = await installSkills(
        scan.scanId,
        selectedSkills.map((s) => ({ name: s.name, skillPath: s.skillPath }))
      );
      setInstalled(res.installed);
    } catch (e) {
      // Kept beside the confirm button as well as in the page banner: the banner sits above a long
      // scrolled report list, so on its own the failure reads as nothing having happened.
      setInstallError(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ResourcePanel crumbs={[{ label: "skills", to: "/skills" }, { label: "marketplace" }]}>
      <SkillsTabs />
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
          {/* Official marketplace catalog (SKL-V1-005) — reviewing feeds the same select → audit →
              confirm pipeline as a manual scan. Hidden once a scan is active. */}
          {catalog && catalog.skills.length > 0 && !scan ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  official marketplace · {catalog.source}
                </p>
                <div className="flex items-center gap-2">
                  {updateCount > 0 ? (
                    <span className="rounded-sm border border-primary px-2 py-1 text-xs uppercase tracking-[0.15em] text-primary">
                      {updateCount} {updateCount === 1 ? "update" : "updates"} available
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => loadIntoPipeline(catalog.scanId, catalog.skills)}
                  >
                    Review all ({catalog.skills.length})
                  </Button>
                </div>
              </div>
              {/* Groups scroll within the panel so the page itself does not grow with the catalog. */}
              <div className="flex max-h-96 flex-col gap-3 overflow-y-auto rounded-sm border border-border p-3">
                {[...catalogGroups].map(([category, skills]) => (
                  <section key={category} aria-labelledby={`category-${category}`}>
                    <h2
                      id={`category-${category}`}
                      className="mb-1 text-xs uppercase tracking-[0.2em] text-muted-foreground"
                    >
                      {category.replaceAll("-", " ")}
                    </h2>
                    <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
                      {skills.map((s) => (
                        <li key={skillRowKey(s)} className="flex items-center gap-3 px-3 py-2">
                          <span className="font-medium text-foreground">{s.name}</span>
                          {s.description ? (
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {s.description}
                            </span>
                          ) : (
                            <span className="flex-1" />
                          )}
                          {s.installs !== undefined ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {s.installs} installs
                            </span>
                          ) : null}
                          {s.installed && !s.updateAvailable ? (
                            <InstallBadge installed updateAvailable={false} />
                          ) : (
                            <Button
                              size="sm"
                              variant={s.updateAvailable ? "default" : "outline"}
                              className="shrink-0"
                              disabled={busy !== null}
                              // The catalog is ~88 identical actions deep, so the visible text is
                              // the only thing distinguishing them and it is the same on every row.
                              // Name the Skill in the label so navigating by role stays usable.
                              aria-label={`${s.updateAvailable ? "Update" : "Install"} ${s.name}`}
                              onClick={() => loadIntoPipeline(catalog.scanId, [s])}
                            >
                              {s.updateAvailable ? "Update" : "Install"}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              <p className="border-t border-border pt-4 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                or install from any git repo
              </p>
            </div>
          ) : null}

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
                placeholder="owner/repo[#branch]  or  https://github.com/owner/repo"
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
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {scan.skills.length} discovered — select skills to review
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setScan(null);
                    setSelected(new Set());
                    setReports({});
                    setInstallError(null);
                  }}
                >
                  ← Back
                </Button>
              </div>
              <ul className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto rounded-sm border border-border">
                {scan.skills.map((s) => (
                  <li key={skillRowKey(s)}>
                    <label className="flex cursor-pointer items-baseline gap-2 px-3 py-2 hover:bg-accent">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={selected.has(skillRowKey(s))}
                        onChange={() => toggle(skillRowKey(s))}
                        disabled={busy !== null}
                      />
                      <span className="font-medium text-foreground">{s.name}</span>
                      {s.description ? (
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {s.description}
                        </span>
                      ) : (
                        <span className="flex-1" />
                      )}
                      <span className="ml-auto flex shrink-0 items-baseline gap-2">
                        <InstallBadge installed={s.installed} updateAvailable={s.updateAvailable} />
                        {reports[skillRowKey(s)] ? (
                          <span
                            className={`rounded-sm border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] ${RISK_CLASS[reports[skillRowKey(s)].riskRating]}`}
                          >
                            {reports[skillRowKey(s)].riskRating}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {/* Once the selection is audited the only action left is confirm; offering both at
                  once left the operator unable to tell which one advanced the flow (#444). */}
              {allAudited ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => void onAudit()}
                  disabled={busy !== null || selectedSkills.length === 0}
                >
                  {busy === "audit" ? "Auditing…" : `Run SkillAudit (${selectedSkills.length})`}
                </Button>
              )}
            </div>
          ) : null}

          {/* Step 3 — advisory reports + explicit operator confirm. */}
          {allAudited ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              {selectedSkills.map((s) => (
                <AuditReportCard
                  key={skillRowKey(s)}
                  name={s.name}
                  report={reports[skillRowKey(s)]}
                />
              ))}
              {severeSelected.length > 0 ? (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-destructive"
                >
                  <p className="text-sm font-medium">
                    {severeSelected.length === 1
                      ? "1 serious finding in this package"
                      : `${severeSelected.length} serious findings in these packages`}
                  </p>
                  <ul className="flex flex-col gap-1 text-xs">
                    {severeSelected.map(({ skillName, finding }) => (
                      <li key={`${skillName}-${finding.patternId}-${finding.file}-${finding.line}`}>
                        <span className="uppercase tracking-[0.15em]">{finding.severity}</span>{" "}
                        {skillName}: {finding.description} ({finding.file}:{finding.line})
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs">
                    Installing is still your call, but nothing here is sandboxed. Only go ahead if
                    you trust this source.
                  </p>
                </div>
              ) : null}
              <p className="rounded-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                SkillAudit is <span className="text-foreground">advisory, not a guarantee</span>. A
                skill is natural-language instruction and cannot be sandboxed — it may read benign
                yet behave badly in context, and injection can be obscured. Installed skills run
                with full tool access (no per-skill ACL in V1). Confirming installs these skills
                into your soul repo.
              </p>
              {installError ? (
                <p
                  ref={installErrorRef}
                  tabIndex={-1}
                  role="alert"
                  className="rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-destructive outline-none"
                >
                  install failed: {installError}
                </p>
              ) : null}
              <Button
                size="sm"
                variant={severeSelected.length > 0 ? "destructive" : "default"}
                className="self-start"
                onClick={() => void onInstall()}
                disabled={busy !== null}
              >
                {busy === "install"
                  ? "Installing…"
                  : severeSelected.length > 0
                    ? `Install anyway (${selectedSkills.length})`
                    : `Confirm install (${selectedSkills.length})`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ResourcePanel>
  );
}
