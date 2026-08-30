import type { SkillPackageFile, SkillSummary } from "./skills";

/**
 * What a Skill costs you to install, as one ordered word.
 *
 * A Skill carries no authority of its own — it runs under the Agent that loaded it — so this is not
 * a permission level. It is the honest answer to "what does this package reach", which is the
 * question an operator actually has in front of an install button, and it is ordered because the
 * reasons stack: reaching the network is strictly more than running a command locally, which is
 * strictly more than being nothing but instructions.
 */
export type SkillReach = "instructions-only" | "runs-code" | "reaches-network" | "needs-secrets";

export const SKILL_REACH_LABEL: Record<SkillReach, string> = {
  "instructions-only": "Instructions only",
  "runs-code": "Runs code",
  "reaches-network": "Reaches network",
  "needs-secrets": "Needs secrets",
};

export const SKILL_REACH_HINT: Record<SkillReach, string> = {
  "instructions-only": "Text the agent reads. It runs nothing and reaches nothing.",
  "runs-code": "Runs commands in a sandbox with no network.",
  "reaches-network": "Runs commands that can reach the hosts it declares.",
  "needs-secrets": "Runs with one of your stored secrets leased to it.",
};

export const SKILL_REACH_ORDER: readonly SkillReach[] = [
  "instructions-only",
  "runs-code",
  "reaches-network",
  "needs-secrets",
];

export type SkillFacts = {
  reach: SkillReach;
  /** One sentence naming why the reach is what it is. */
  headline: string;
  tools: string[];
  domains: string[];
  commands: string[];
  secrets: string[];
  /** True when the Skill declared nothing at all beyond its name and description. */
  declaresNothing: boolean;
};

function list(values: readonly string[] | undefined): string[] {
  return values ? [...values] : [];
}

/**
 * Everything the list and the detail page assert about one Skill, derived once.
 *
 * Pure and total: a Skill that declares nothing is the common case (most Skills are prose), so
 * every field has an empty answer rather than an absent one and no caller has to null-check.
 */
export function skillFacts(skill: SkillSummary): SkillFacts {
  const tools = list(skill.tools);
  const domains = list(skill.allowedDomains);
  const commands = list(skill.allowedCommands);
  const secrets = list(skill.requiredSecrets);

  const reach: SkillReach =
    secrets.length > 0
      ? "needs-secrets"
      : domains.length > 0
        ? "reaches-network"
        : commands.length > 0
          ? "runs-code"
          : "instructions-only";

  const headline =
    secrets.length > 0
      ? `Leases ${secrets.length === 1 ? "1 secret" : `${secrets.length} secrets`} while it runs.`
      : domains.length > 0
        ? `Can reach ${domains.length === 1 ? domains[0] : `${domains.length} hosts`}.`
        : commands.length > 0
          ? `Can run ${commands.length === 1 ? "1 command" : `${commands.length} commands`} in a sandbox.`
          : "Nothing but instructions for the agent that loads it.";

  return {
    reach,
    headline,
    tools,
    domains,
    commands,
    secrets,
    declaresNothing:
      tools.length === 0 && domains.length === 0 && commands.length === 0 && secrets.length === 0,
  };
}

/** Category label for grouping. A Skill without one is not hidden, it is grouped as uncategorised. */
export const UNCATEGORISED = "uncategorised";

export function skillCategory(skill: SkillSummary): string {
  return skill.category ?? UNCATEGORISED;
}

/**
 * Skills grouped by their declared category, each group sorted by name.
 *
 * `uncategorised` always sorts last however it collates, because it is the absence of an answer
 * rather than one of the answers and reading it between two real categories implies otherwise.
 */
export function groupByCategory(skills: readonly SkillSummary[]): [string, SkillSummary[]][] {
  const groups = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    const key = skillCategory(skill);
    const group = groups.get(key);
    if (group) group.push(skill);
    else groups.set(key, [skill]);
  }
  return [...groups]
    .map(([category, members]) => {
      members.sort((left, right) => left.name.localeCompare(right.name));
      return [category, members] as [string, SkillSummary[]];
    })
    .sort(([left], [right]) => {
      if (left === UNCATEGORISED) return 1;
      if (right === UNCATEGORISED) return -1;
      return left.localeCompare(right);
    });
}

/** Grouping earns its headings only when it separates something; one group is just an extra line. */
export function shouldGroupByCategory(groups: readonly [string, SkillSummary[]][]): boolean {
  return groups.length > 1;
}

/**
 * Whether a Skill matches a free-text query.
 *
 * Matches the tool names too: "which of my Skills touch Slack" is asked by typing `slack`, and a
 * name-and-description search answers it wrongly for a Skill whose description never says so.
 */
export function matchesSkillQuery(skill: SkillSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    skill.name,
    skill.description ?? "",
    skill.category ?? "",
    ...(skill.tools ?? []),
    ...(skill.allowedDomains ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/** What a file in a Skill package is for, which is what decides where it is shown. */
export type SkillFileKind = "manifest" | "reference" | "script" | "asset";

export const SKILL_FILE_KIND_LABEL: Record<SkillFileKind, string> = {
  manifest: "Manifest",
  reference: "References",
  script: "Scripts",
  asset: "Assets",
};

export const SKILL_FILE_KIND_HINT: Record<SkillFileKind, string> = {
  manifest: "The instructions the agent is given when it loads this skill.",
  reference: "Extra pages the skill tells the agent to open when it needs them.",
  script: "Code this skill can run. Read it before you trust the skill.",
  asset: "Templates, data and everything else the package ships.",
};

const SCRIPT_EXTENSIONS = new Set([
  "sh",
  "bash",
  "zsh",
  "py",
  "ts",
  "js",
  "mjs",
  "cjs",
  "rb",
  "pl",
  "ps1",
]);

const TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "xml",
  "html",
  "css",
  "sql",
  "env",
  "ini",
  "conf",
]);

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function skillFileKind(path: string): SkillFileKind {
  if (path === "SKILL.md") return "manifest";
  const ext = extension(path);
  if (SCRIPT_EXTENSIONS.has(ext)) return "script";
  if (path.startsWith("references/") || ext === "md" || ext === "mdx") return "reference";
  return "asset";
}

/**
 * True when a file is worth offering to open in a text panel.
 *
 * An extension allowlist rather than a binary sniff: this decides whether to render a control, and
 * the server is the one that can actually tell, so guessing wrong here costs a disabled button
 * rather than a screenful of replacement characters.
 */
export function isReadableSkillFile(path: string): boolean {
  const ext = extension(path);
  return ext === "" ? false : TEXT_EXTENSIONS.has(ext) || SCRIPT_EXTENSIONS.has(ext);
}

export const SKILL_FILE_KIND_ORDER: readonly SkillFileKind[] = [
  "manifest",
  "reference",
  "script",
  "asset",
];

/** A Skill package split by what each file is for, in reading order, empty kinds dropped. */
export function groupPackageFiles(
  files: readonly SkillPackageFile[]
): [SkillFileKind, SkillPackageFile[]][] {
  const groups = new Map<SkillFileKind, SkillPackageFile[]>();
  for (const file of files) {
    const kind = skillFileKind(file.path);
    const group = groups.get(kind);
    if (group) group.push(file);
    else groups.set(kind, [file]);
  }
  return SKILL_FILE_KIND_ORDER.flatMap((kind) => {
    const group = groups.get(kind);
    if (!group) return [];
    group.sort((left, right) => left.path.localeCompare(right.path));
    return [[kind, group] as [SkillFileKind, SkillPackageFile[]]];
  });
}

/** Bytes as something a person reads, so a 4601-byte reference does not present as a raw integer. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
