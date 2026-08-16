import { createHash } from "node:crypto";
import { extname } from "node:path";
import { THREAT_PATTERNS } from "./threat-patterns";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingCategory =
  | "exfiltration"
  | "injection"
  | "destructive"
  | "obfuscation"
  | "network"
  | "persistence";
export type GuardVerdict = "safe" | "caution" | "dangerous";
export type SkillTrustLevel = "builtin" | "trusted" | "community";

export interface Finding {
  patternId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  file: string;
  line: number;
  match: string;
  description: string;
}

export interface GuardResult {
  verdict: GuardVerdict;
  findings: Finding[];
}

export interface SkillScanFile {
  path: string;
  content: string;
  size?: number;
  symlinkTarget?: string;
  symlinkEscapes?: boolean;
}

export const GUARD_VERSION = "skills-guard-v1";

const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE_BYTES = 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;
const MAX_MATCH_LENGTH = 120;
const MAX_CACHE_ENTRIES = 256;

const SUSPICIOUS_BINARY_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".com",
  ".msi",
  ".dmg",
  ".app",
  ".deb",
  ".rpm",
]);

const INVISIBLE_CHARS = new Map([
  ["\u200b", "zero-width space"],
  ["\u200c", "zero-width non-joiner"],
  ["\u200d", "zero-width joiner"],
  ["\u2060", "word joiner"],
  ["\u2062", "invisible times"],
  ["\u2063", "invisible separator"],
  ["\u2064", "invisible plus"],
  ["\ufeff", "BOM/zero-width no-break space"],
  ["\u202a", "LTR embedding"],
  ["\u202b", "RTL embedding"],
  ["\u202c", "pop directional"],
  ["\u202d", "LTR override"],
  ["\u202e", "RTL override"],
  ["\u2066", "LTR isolate"],
  ["\u2067", "RTL isolate"],
  ["\u2068", "first strong isolate"],
  ["\u2069", "pop directional isolate"],
]);

export { THREAT_PATTERNS } from "./threat-patterns";

const scanCache = new Map<string, GuardResult>();

function truncateMatch(value: string): string {
  const match = value.trim();
  if (match.length <= MAX_MATCH_LENGTH) return match;
  return `${match.slice(0, MAX_MATCH_LENGTH - 3)}...`;
}

function structuralFindings(files: readonly SkillScanFile[]): Finding[] {
  const findings: Finding[] = [];
  let totalSize = 0;

  for (const file of files) {
    const size = file.size ?? Buffer.byteLength(file.content);
    totalSize += size;

    if (file.symlinkEscapes) {
      findings.push({
        patternId: "symlink_escape",
        severity: "critical",
        category: "exfiltration",
        file: file.path,
        line: 0,
        match: truncateMatch(`symlink -> ${file.symlinkTarget ?? "(unknown)"}`),
        description: "symlink points outside the Skill directory",
      });
    }
    if (size > MAX_SINGLE_FILE_BYTES) {
      findings.push({
        patternId: "oversized_file",
        severity: "medium",
        category: "obfuscation",
        file: file.path,
        line: 0,
        match: `${Math.floor(size / 1024)}KB`,
        description: "file exceeds the 256KB structural limit",
      });
    }
    const extension = extname(file.path).toLowerCase();
    if (SUSPICIOUS_BINARY_EXTENSIONS.has(extension)) {
      findings.push({
        patternId: "binary_file",
        severity: "critical",
        category: "obfuscation",
        file: file.path,
        line: 0,
        match: `binary: ${extension}`,
        description: "binary or executable file should not be in a Skill",
      });
    }
  }

  if (files.length > MAX_FILE_COUNT) {
    findings.push({
      patternId: "too_many_files",
      severity: "medium",
      category: "obfuscation",
      file: "(directory)",
      line: 0,
      match: `${files.length} files`,
      description: "Skill exceeds the 50-file structural limit",
    });
  }
  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    findings.push({
      patternId: "oversized_skill",
      severity: "high",
      category: "obfuscation",
      file: "(directory)",
      line: 0,
      match: `${Math.floor(totalSize / 1024)}KB total`,
      description: "Skill exceeds the 1MB structural limit",
    });
  }

  return findings;
}

function patternFindings(file: SkillScanFile): Finding[] {
  const findings: Finding[] = [];
  const lines = file.content.split("\n");

  for (const threat of THREAT_PATTERNS) {
    for (const [index, line] of lines.entries()) {
      if (!threat.pattern.test(line)) continue;
      findings.push({
        patternId: threat.id,
        severity: threat.severity,
        category: threat.category,
        file: file.path,
        line: index + 1,
        match: truncateMatch(line),
        description: threat.description,
      });
    }
  }

  for (const [index, line] of lines.entries()) {
    for (const [character, name] of INVISIBLE_CHARS) {
      if (!line.includes(character)) continue;
      const codePoint = character.codePointAt(0);
      findings.push({
        patternId: "invisible_unicode",
        severity: "critical",
        category: "injection",
        file: file.path,
        line: index + 1,
        match: `U+${codePoint?.toString(16).toUpperCase().padStart(4, "0") ?? "????"} (${name})`,
        description: `invisible unicode character ${name} (possible text hiding or injection)`,
      });
      break;
    }
  }

  return findings;
}

function determineVerdict(findings: readonly Finding[]): GuardVerdict {
  if (findings.some((finding) => finding.severity === "critical")) return "dangerous";
  if (findings.some((finding) => finding.severity === "high")) return "caution";
  return "safe";
}

function contentDigest(files: readonly SkillScanFile[]): string {
  const hash = createHash("sha256");
  hash.update(GUARD_VERSION);
  hash.update("\0");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function scanSkill(files: readonly SkillScanFile[]): GuardResult {
  const cacheKey = contentDigest(files);
  const cached = scanCache.get(cacheKey);
  if (cached) return cached;

  const findings = [
    ...structuralFindings(files),
    ...files.flatMap((file) => patternFindings(file)),
  ];
  const result = { verdict: determineVerdict(findings), findings };
  scanCache.set(cacheKey, result);
  while (scanCache.size > MAX_CACHE_ENTRIES) {
    const oldest = scanCache.keys().next().value;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
  return result;
}

export function skillTrustLevel(source: string): SkillTrustLevel {
  const normalized = source
    .split("#", 1)[0]
    ?.replace(/\.git$/i, "")
    .toLowerCase();
  if (normalized === "builtin") return "builtin";
  if (normalized === "tulipfarm/skills" || normalized === "https://github.com/tulipfarm/skills") {
    return "trusted";
  }
  return "community";
}
