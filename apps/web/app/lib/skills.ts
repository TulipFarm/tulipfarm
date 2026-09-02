import { apiDelete, apiGet, apiWrite, shareInFlight } from "./api";

/* Skill installs publish executable commands only after server-side package/runtime gates pass. */

/**
 * Where a Skill came from, mirroring `skills-lock.json`.
 *
 * `bundled` ships with the app, `marketplace` comes from the official catalog, `public` from any
 * other source on the internet, and `curated` was authored in this business.
 */
export type SkillProvenance = "bundled" | "marketplace" | "public" | "curated";

export type SkillSummary = {
  name: string;
  description?: string;
  provenance: SkillProvenance;
  /** The Skill's own version, from its SKILL.md. */
  version?: string;
  // The git source (e.g. "owner/repo") for an installed Skill. Undefined for bundled/curated.
  source?: string;
  /** The author's own grouping, e.g. `forge`. Free text, so never switch on a fixed set. */
  category?: string;
  /** Tool names the Skill narrows the model's view to while it is loaded. */
  tools?: string[];
  /** Hosts a Skill command may reach. Absent means the sandbox gets no network at all. */
  allowedDomains?: string[];
  /** Shell command patterns the Skill will admit. */
  allowedCommands?: string[];
  /** Secret names the Skill needs leased to it. */
  requiredSecrets?: string[];
};

export type SkillPackageFile = { path: string; size: number };

export type SkillFileContent = {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  binary?: boolean;
};

export type SkillCommandDetail = {
  name: string;
  toolRef: string;
  runtimeProfile: string;
  entrypoint: string;
  requiredCommands: string[];
  runtimeAvailable: boolean;
  blocker?: string;
};

export type SkillDetail = SkillSummary & {
  author?: string;
  license?: string;
  body: string;
  files: SkillPackageFile[];
  commands: SkillCommandDetail[];
};

// `installed` / `updateAvailable` come from the server cross-referencing the discovered SKILL.md
// against the soul repo + skills-lock hash, so the UI can badge already-installed and stale skills.
export type SkillInstallStatus = { installed: boolean; updateAvailable: boolean };

export type ScannedSkill = {
  name: string;
  skillPath?: string;
  description?: string;
} & SkillInstallStatus;
export type ScanResult = { scanId: string; skills: ScannedSkill[] };

export type MarketplaceSkill = {
  name: string;
  skillPath?: string;
  skillId?: string;
  description?: string;
  category?: string;
  installs?: number;
} & SkillInstallStatus;

/**
 * A stable identity for one scanned row.
 *
 * `name` is not unique within a source — one repo can define two different skills with the same
 * directory name under different parents — so keying a React list or a selection by it merges two
 * distinct rows into one.
 */
export function skillRowKey(skill: { name: string; skillPath?: string }): string {
  return skill.skillPath ?? skill.name;
}

// The official curated catalog (SKL-V1-005). The scanId plugs into the same audit/install flow as a
// manual git-URL scan, so the operator-confirm gate applies unchanged.
export type MarketplaceCatalog = { scanId: string; source: string; skills: MarketplaceSkill[] };

export type SkillAuditFinding = {
  severity: "info" | "warning" | "critical";
  category: string;
  detail: string;
};

export type SkillGuardFinding = {
  patternId: string;
  severity: "critical" | "high" | "medium" | "low";
  category:
    | "exfiltration"
    | "injection"
    | "destructive"
    | "obfuscation"
    | "network"
    | "persistence";
  file: string;
  line: number;
  match: string;
  description: string;
};

export type SkillAuditReport = {
  riskRating: "low" | "medium" | "high";
  summary: string;
  toolsReach: string[];
  findings: SkillAuditFinding[];
  deterministicScan: {
    verdict: "safe" | "caution" | "dangerous";
    trustLevel: "builtin" | "trusted" | "community";
    findings: SkillGuardFinding[];
  };
};

export const listSkills = shareInFlight(async (): Promise<SkillSummary[]> => {
  const body = await apiGet<{ skills: SkillSummary[] }>("/api/v1/skills");
  return body.skills;
});

export async function getSkill(name: string): Promise<SkillDetail> {
  return apiGet<SkillDetail>(`/api/v1/skills/${encodeURIComponent(name)}`);
}

/** Read one file out of an installed Skill's package, so a reference can be read before it is trusted. */
export async function getSkillFile(name: string, path: string): Promise<SkillFileContent> {
  return apiGet<SkillFileContent>(
    `/api/v1/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`
  );
}

// Clone a git repo and discover installable SKILL.md files. Returns a scanId the audit/install steps
// reference so the server reuses the already-cloned content instead of re-cloning.
export async function scanSkills(source: string): Promise<ScanResult> {
  return apiWrite<ScanResult>("POST", "/api/v1/skills/scan", { source });
}

export async function auditSkill(
  scanId: string,
  name: string,
  skillPath?: string
): Promise<SkillAuditReport> {
  const body = await apiWrite<{ report: SkillAuditReport }>("POST", "/api/v1/skills/audit", {
    scanId,
    name,
    skillPath,
  });
  return body.report;
}

/**
 * Operator confirm step: install the selected scanned rows into the soul repo.
 *
 * Rows are sent as `paths` so the server installs exactly what the operator reviewed; `names`
 * is the fallback for a source whose scan predates `skillPath` and cannot tell two same-named
 * packages apart.
 */
export async function installSkills(
  scanId: string,
  skills: readonly { name: string; skillPath?: string }[]
): Promise<{ installed: string[] }> {
  const paths = skills.flatMap((skill) => (skill.skillPath ? [skill.skillPath] : []));
  const body =
    paths.length === skills.length
      ? { scanId, paths }
      : { scanId, names: skills.map((skill) => skill.name) };
  return apiWrite<{ installed: string[] }>("POST", "/api/v1/skills/install", body);
}

export async function marketplaceSkills(): Promise<MarketplaceCatalog> {
  return apiGet<MarketplaceCatalog>("/api/v1/skills/marketplace");
}

export async function removeSkill(name: string): Promise<void> {
  return apiDelete(`/api/v1/skills/${encodeURIComponent(name)}`);
}
