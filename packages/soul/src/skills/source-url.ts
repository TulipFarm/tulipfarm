/**
 * Turn the URL a person actually has into the git source the clone gate accepts.
 *
 * A catalogue page and a deep link into a repository tree both name one Skill inside a repository,
 * but neither is a clonable remote. Resolution is pure string work on purpose: a catalogue that had
 * to be queried at install time would put a third party on the path of every install, and would
 * fail closed the day that party is down.
 */

const SEGMENT = /^[\w.-]+$/;
const SKILLS_SH_HOSTS = new Set(["skills.sh", "www.skills.sh"]);
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export interface ResolvedSkillSource {
  /** Git source for the clone gate, carrying a `#ref` suffix when one was named. */
  readonly source: string;
  /** The Skill directory the URL pointed at, when it named one rather than a whole repository. */
  readonly skillHint?: string;
}

function splitRef(input: string): { base: string; ref?: string } {
  const hash = input.indexOf("#");
  if (hash === -1) return { base: input };
  return { base: input.slice(0, hash), ref: input.slice(hash + 1) || undefined };
}

function repository(owner: string, repo: string): string | undefined {
  const name = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return undefined;
  return `https://github.com/${owner}/${name}.git`;
}

function withRef(source: string, ref: string | undefined): string {
  return ref ? `${source}#${ref}` : source;
}

/**
 * Map a catalogue page, a repository URL, a deep tree link or an `owner/repo` slug onto a git
 * source. Anything this cannot recognise is returned untouched so the clone gate — the one place
 * allowed to decide what may be fetched — still gets to rule on it.
 */
export function resolveSkillSource(input: string): ResolvedSkillSource {
  const trimmed = input.trim();
  const { base, ref: explicitRef } = splitRef(trimmed);

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { source: trimmed };
  }
  if (url.protocol !== "https:") return { source: trimmed };

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment !== "");

  if (SKILLS_SH_HOSTS.has(host)) {
    // `skills.sh/<owner>/<repo>/<skill>` mirrors the repository that backs the catalogue entry.
    const [owner, repo, skill] = segments;
    if (owner === undefined || repo === undefined) return { source: trimmed };
    const source = repository(owner, repo);
    if (!source) return { source: trimmed };
    const skillHint = skill !== undefined && SEGMENT.test(skill) ? skill : undefined;
    return { source: withRef(source, explicitRef), skillHint };
  }

  if (GITHUB_HOSTS.has(host)) {
    const [owner, repo, kind, ...rest] = segments;
    if (owner === undefined || repo === undefined) return { source: trimmed };
    const source = repository(owner, repo);
    if (!source) return { source: trimmed };

    if (kind !== "tree" && kind !== "blob") return { source: withRef(source, explicitRef) };

    // `/tree/<ref>/<path>`: a ref containing a slash is indistinguishable from the path here, so
    // the first segment is taken as the ref and a wrong guess fails loudly at clone time. Name
    // such a branch with an explicit `#ref` suffix instead.
    const [urlRef, ...path] = rest;
    // A `blob` link usually points at the `SKILL.md` itself; the package is its parent directory.
    const leaf = path.at(-1) === "SKILL.md" ? path.at(-2) : path.at(-1);
    const skillHint = leaf !== undefined && SEGMENT.test(leaf) ? leaf : undefined;
    return { source: withRef(source, explicitRef ?? urlRef), skillHint };
  }

  return { source: trimmed };
}
