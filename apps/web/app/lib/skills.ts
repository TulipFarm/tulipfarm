import { apiDelete, apiGet, apiWrite } from "./api";

/*
 * Client for the skills API (SKILLS / SKL-V1-001..003). Skills are SKILL.md files in the soul repo.
 * Read endpoints (list/get) plus the install-from-git flow: scan a git repo, run an advisory
 * SkillAudit on a discovered skill, then explicitly confirm the install. The audit is advisory only —
 * a skill cannot be sandboxed, so the operator confirms install regardless of the rating.
 */

export type SkillProvenance = "builtin" | "marketplace" | "user";

export type SkillSummary = {
  name: string;
  description?: string;
  provenance: SkillProvenance;
  // For marketplace skills: the git source (e.g. "owner/repo"). Undefined for builtin/user.
  source?: string;
};

export type SkillDetail = SkillSummary & { body: string };

// `installed` / `updateAvailable` come from the server cross-referencing the discovered SKILL.md
// against the soul repo + skills-lock hash, so the UI can badge already-installed and stale skills.
export type SkillInstallStatus = { installed: boolean; updateAvailable: boolean };

export type ScannedSkill = { name: string; description?: string } & SkillInstallStatus;
export type ScanResult = { scanId: string; skills: ScannedSkill[] };

export type MarketplaceSkill = {
  name: string;
  skillId?: string;
  description?: string;
  category?: string;
  installs?: number;
} & SkillInstallStatus;

// The official curated catalog (SKL-V1-005). The scanId plugs into the same audit/install flow as a
// manual git-URL scan, so the operator-confirm gate applies unchanged.
export type MarketplaceCatalog = { scanId: string; source: string; skills: MarketplaceSkill[] };

export type SkillAuditFinding = {
  severity: "info" | "warning" | "critical";
  category: string;
  detail: string;
};

export type SkillAuditReport = {
  riskRating: "low" | "medium" | "high";
  summary: string;
  toolsReach: string[];
  findings: SkillAuditFinding[];
};

export async function listSkills(): Promise<SkillSummary[]> {
  const body = await apiGet<{ skills: SkillSummary[] }>("/api/v1/skills");
  return body.skills;
}

export async function getSkill(name: string): Promise<SkillDetail> {
  return apiGet<SkillDetail>(`/api/v1/skills/${encodeURIComponent(name)}`);
}

// Clone a git repo and discover installable SKILL.md files. Returns a scanId the audit/install steps
// reference so the server reuses the already-cloned content instead of re-cloning.
export async function scanSkills(source: string): Promise<ScanResult> {
  return apiWrite<ScanResult>("POST", "/api/v1/skills/scan", { source });
}

export async function auditSkill(scanId: string, name: string): Promise<SkillAuditReport> {
  const body = await apiWrite<{ report: SkillAuditReport }>("POST", "/api/v1/skills/audit", {
    scanId,
    name,
  });
  return body.report;
}

// Operator confirm step: actually install the named scanned skills into the soul repo.
export async function installSkills(
  scanId: string,
  names: string[]
): Promise<{ installed: string[] }> {
  return apiWrite<{ installed: string[] }>("POST", "/api/v1/skills/install", { scanId, names });
}

export async function marketplaceSkills(): Promise<MarketplaceCatalog> {
  return apiGet<MarketplaceCatalog>("/api/v1/skills/marketplace");
}

export async function skillUpdates(): Promise<MarketplaceCatalog> {
  return apiGet<MarketplaceCatalog>("/api/v1/skills/updates");
}

export async function removeSkill(name: string): Promise<void> {
  return apiDelete(`/api/v1/skills/${encodeURIComponent(name)}`);
}
