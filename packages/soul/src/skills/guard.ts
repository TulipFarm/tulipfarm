import { createHash } from "node:crypto";
import { extname } from "node:path";

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

interface ThreatPattern {
  pattern: RegExp;
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  description: string;
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

function threatPattern(
  pattern: RegExp,
  id: string,
  severity: FindingSeverity,
  category: FindingCategory,
  description: string
): ThreatPattern {
  return { pattern, id, severity, category, description };
}

export const THREAT_PATTERNS: readonly ThreatPattern[] = [
  threatPattern(
    /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    "env_exfil_curl",
    "critical",
    "exfiltration",
    "curl command interpolating secret environment variable"
  ),
  threatPattern(
    /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    "env_exfil_wget",
    "critical",
    "exfiltration",
    "wget command interpolating secret environment variable"
  ),
  threatPattern(
    /fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i,
    "env_exfil_fetch",
    "critical",
    "exfiltration",
    "fetch() call interpolating secret environment variable"
  ),
  threatPattern(
    /httpx?\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i,
    "env_exfil_httpx",
    "critical",
    "exfiltration",
    "HTTP library call with secret variable"
  ),
  threatPattern(
    /requests\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i,
    "env_exfil_requests",
    "critical",
    "exfiltration",
    "requests library call with secret variable"
  ),
  threatPattern(
    /base64[^\n]*env/i,
    "encoded_exfil",
    "high",
    "exfiltration",
    "base64 encoding combined with environment access"
  ),
  threatPattern(
    /\$HOME\/\.ssh|~\/\.ssh/i,
    "ssh_dir_access",
    "high",
    "exfiltration",
    "references user SSH directory"
  ),
  threatPattern(
    /\$HOME\/\.aws|~\/\.aws/i,
    "aws_dir_access",
    "high",
    "exfiltration",
    "references user AWS credentials directory"
  ),
  threatPattern(
    /\$HOME\/\.gnupg|~\/\.gnupg/i,
    "gpg_dir_access",
    "high",
    "exfiltration",
    "references user GPG keyring"
  ),
  threatPattern(
    /\$HOME\/\.kube|~\/\.kube/i,
    "kube_dir_access",
    "high",
    "exfiltration",
    "references Kubernetes config directory"
  ),
  threatPattern(
    /\$HOME\/\.docker|~\/\.docker/i,
    "docker_dir_access",
    "high",
    "exfiltration",
    "references Docker config that may contain registry credentials"
  ),
  threatPattern(
    /(?:\$HOME\/|~\/)(?:\.tulipfarm\/)?\.env(?:\.local)?/i,
    "tulipfarm_env_access",
    "critical",
    "exfiltration",
    "directly references a TulipFarm secrets file"
  ),
  // Keep Hermes' negative lookahead verbatim: `cat >` writes a file and must not be classified as
  // reading credentials.
  threatPattern(
    /cat\s+(?!>)[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    "read_secrets_file",
    "critical",
    "exfiltration",
    "reads known secrets file"
  ),
  threatPattern(
    /printenv|env\s*\|/i,
    "dump_all_env",
    "high",
    "exfiltration",
    "dumps all environment variables"
  ),
  // Keep Hermes' nested negative lookaheads verbatim: ordinary config reads stay clean while
  // secret-shaped identifiers continue to match the dedicated rule below.
  threatPattern(
    /os\.environ\b(?!\s*\.get\s*\(\s*["'](?![^"']*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)))/i,
    "python_os_environ",
    "high",
    "exfiltration",
    "accesses os.environ (potential environment dump)"
  ),
  threatPattern(
    /os\.environ\s*\.get\s*\(\s*["'][^"']*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    "python_environ_get_secret",
    "critical",
    "exfiltration",
    "reads secret via os.environ.get()"
  ),
  threatPattern(
    /os\.getenv\s*\(\s*[^)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    "python_getenv_secret",
    "critical",
    "exfiltration",
    "reads secret via os.getenv()"
  ),
  threatPattern(
    /process\.env\[/i,
    "node_process_env",
    "high",
    "exfiltration",
    "accesses process.env"
  ),
  threatPattern(
    /ENV\[.*(?:KEY|TOKEN|SECRET|PASSWORD)/i,
    "ruby_env_secret",
    "critical",
    "exfiltration",
    "reads secret via Ruby ENV[]"
  ),
  threatPattern(
    /\b(dig|nslookup|host)\s+[^\n]*\$/i,
    "dns_exfil",
    "critical",
    "exfiltration",
    "DNS lookup with variable interpolation"
  ),
  threatPattern(
    />\s*\/tmp\/[^\s]*\s*&&\s*(curl|wget|nc|python)/i,
    "tmp_staging",
    "critical",
    "exfiltration",
    "writes to /tmp then exfiltrates"
  ),
  threatPattern(
    /!\[.*\]\(https?:\/\/[^)]*\$\{?/i,
    "md_image_exfil",
    "high",
    "exfiltration",
    "markdown image URL with variable interpolation"
  ),
  threatPattern(
    /\[.*\]\(https?:\/\/[^)]*\$\{?/i,
    "md_link_exfil",
    "high",
    "exfiltration",
    "markdown link with variable interpolation"
  ),
  threatPattern(
    /(include|output|print|send|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|context)/i,
    "context_exfil",
    "high",
    "exfiltration",
    "instructs agent to output or share conversation history"
  ),
  threatPattern(
    /(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?:\/\//i,
    "send_to_url",
    "high",
    "exfiltration",
    "instructs agent to send data to a URL"
  ),
  threatPattern(
    /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i,
    "prompt_injection_ignore",
    "critical",
    "injection",
    "prompt injection: ignore previous instructions"
  ),
  threatPattern(
    /you\s+are\s+(?:\w+\s+)*now\s+/i,
    "role_hijack",
    "high",
    "injection",
    "attempts to override the agent's role"
  ),
  threatPattern(
    /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i,
    "deception_hide",
    "critical",
    "injection",
    "instructs agent to hide information from user"
  ),
  threatPattern(
    /system\s+(?:\w+\s+)*prompt\s+(?:\w+\s+)*override/i,
    "sys_prompt_override",
    "critical",
    "injection",
    "attempts to override the system prompt"
  ),
  threatPattern(
    /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i,
    "role_pretend",
    "high",
    "injection",
    "attempts to make the agent assume a different identity"
  ),
  threatPattern(
    /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i,
    "disregard_rules",
    "critical",
    "injection",
    "instructs agent to disregard its rules"
  ),
  threatPattern(
    /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i,
    "leak_system_prompt",
    "high",
    "injection",
    "attempts to extract the system prompt"
  ),
  threatPattern(
    /(when|if)\s+no\s*one\s+is\s+(watching|looking)/i,
    "conditional_deception",
    "high",
    "injection",
    "conditional instruction to behave differently when unobserved"
  ),
  threatPattern(
    /act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)/i,
    "bypass_restrictions",
    "critical",
    "injection",
    "instructs agent to act without restrictions"
  ),
  threatPattern(
    /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i,
    "translate_execute",
    "critical",
    "injection",
    "translate-then-execute evasion technique"
  ),
  threatPattern(
    /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
    "html_comment_injection",
    "high",
    "injection",
    "hidden instructions in HTML comments"
  ),
  threatPattern(
    /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i,
    "hidden_div",
    "high",
    "injection",
    "hidden HTML div"
  ),
  threatPattern(
    /\bDAN\s+mode\b|Do\s+Anything\s+Now/i,
    "jailbreak_dan",
    "critical",
    "injection",
    "DAN jailbreak attempt"
  ),
  threatPattern(
    /\bdeveloper\s+mode\b.*\benabled?\b/i,
    "jailbreak_dev_mode",
    "critical",
    "injection",
    "developer mode jailbreak attempt"
  ),
  threatPattern(
    /hypothetical\s+scenario.*(?:ignore|bypass|override)/i,
    "hypothetical_bypass",
    "high",
    "injection",
    "hypothetical scenario used to bypass restrictions"
  ),
  threatPattern(
    /for\s+educational\s+purposes?\s+only/i,
    "educational_pretext",
    "medium",
    "injection",
    "educational pretext often used to justify harmful content"
  ),
  threatPattern(
    /(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)/i,
    "remove_filters",
    "critical",
    "injection",
    "instructs agent to respond without safety filters"
  ),
  threatPattern(
    /you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to/i,
    "fake_update",
    "high",
    "injection",
    "fake update or patch announcement"
  ),
  threatPattern(
    /new\s+(?:\w+\s+)*policy|updated\s+(?:\w+\s+)*guidelines|revised\s+(?:\w+\s+)*instructions/i,
    "fake_policy",
    "medium",
    "injection",
    "claims new policy or guidelines"
  ),
  threatPattern(
    /base64\s+(-d|--decode)\s*\|/i,
    "base64_decode_pipe",
    "high",
    "obfuscation",
    "base64 decodes and pipes to execution"
  ),
  threatPattern(
    /\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}/i,
    "hex_encoded_string",
    "medium",
    "obfuscation",
    "hex-encoded string"
  ),
  threatPattern(
    /\beval\s*\(\s*["']/i,
    "eval_string",
    "high",
    "obfuscation",
    "eval() with string argument"
  ),
  threatPattern(
    /\bexec\s*\(\s*["']/i,
    "exec_string",
    "high",
    "obfuscation",
    "exec() with string argument"
  ),
  threatPattern(
    /echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)/i,
    "echo_pipe_exec",
    "critical",
    "obfuscation",
    "echo piped to interpreter for execution"
  ),
  threatPattern(
    /compile\s*\(\s*[^)]+,\s*["'].*["']\s*,\s*["']exec["']\s*\)/i,
    "python_compile_exec",
    "high",
    "obfuscation",
    "Python compile() with exec mode"
  ),
  threatPattern(
    /getattr\s*\(\s*__builtins__/i,
    "python_getattr_builtins",
    "high",
    "obfuscation",
    "dynamic access to Python builtins"
  ),
  threatPattern(
    /__import__\s*\(\s*["']os["']\s*\)/i,
    "python_import_os",
    "high",
    "obfuscation",
    "dynamic import of os module"
  ),
  threatPattern(
    /codecs\.decode\s*\(\s*["']/i,
    "python_codecs_decode",
    "medium",
    "obfuscation",
    "codecs.decode with a string argument"
  ),
  threatPattern(
    /String\.fromCharCode|charCodeAt/i,
    "js_char_code",
    "medium",
    "obfuscation",
    "JavaScript character code construction"
  ),
  threatPattern(
    /atob\s*\(|btoa\s*\(/i,
    "js_base64",
    "medium",
    "obfuscation",
    "JavaScript base64 encoding or decoding"
  ),
  threatPattern(/\[::-1\]/i, "string_reversal", "low", "obfuscation", "string reversal"),
  threatPattern(
    /chr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(\s*\d+/i,
    "chr_building",
    "high",
    "obfuscation",
    "building a string from chr() calls"
  ),
  threatPattern(
    /\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}/i,
    "unicode_escape_chain",
    "medium",
    "obfuscation",
    "chain of unicode escapes"
  ),
  threatPattern(
    /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b|\b(?:pip|pip3)\s+install\b|\bapt(?:-get)?\s+install\b/i,
    "runtime_install",
    "high",
    "persistence",
    "attempts to install a dependency at execution time instead of using a pinned runtime profile"
  ),
  threatPattern(
    /\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|--data(?:-raw|-binary|-urlencode)?\b)/i,
    "direct_network_mutation",
    "high",
    "network",
    "performs a network mutation that requires a declared destination and mutating Tool approval"
  ),
  threatPattern(
    /\b(?:env|printenv|set)\b[^\n]*(?:curl|wget)|\b(?:curl|wget)\b[^\n]*\$\{?(?:TOKEN|SECRET|PASSWORD|API_KEY)/i,
    "environment_exfiltration",
    "critical",
    "exfiltration",
    "sends environment or credential material over the network"
  ),
  threatPattern(
    /(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|soul\.yaml|guardrails\.yaml|soul\/(?:agents|guardrails)\/)/i,
    "agent_config_mod",
    "critical",
    "persistence",
    "instructs the agent to modify persistent TulipFarm or agent configuration"
  ),
];

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
