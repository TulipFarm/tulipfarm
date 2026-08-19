import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const CONTENT = join(ROOT, "apps/docs/content/docs");

/** Tracked plus new files, so an unstaged page is still checked. Never gitignored output. */
function sourceFiles(...patterns: string[]): string[] {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...patterns];
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && existsSync(join(ROOT, file)));
}

// Git pathspec `**/` skips top-level matches, so filter by extension instead of globbing.
const contentFiles = sourceFiles("apps/docs/content/docs");
const pageFiles = contentFiles.filter((file) => file.endsWith(".mdx"));

type Page = {
  file: string;
  url: string;
  frontmatter: string;
  body: string;
};

function parsePage(file: string): Page {
  const raw = readFileSync(join(ROOT, file), "utf8");
  const match = /^---\n(.*?)\n---\n?/s.exec(raw);
  const slug = relative(CONTENT, join(ROOT, file))
    .replace(/\.mdx$/, "")
    .replace(/(^|\/)index$/, "");
  return {
    file,
    url: `/docs${slug ? `/${slug}` : ""}`.replace(/\/$/, ""),
    frontmatter: match?.[1] ?? "",
    body: match ? raw.slice(match[0].length) : raw,
  };
}

const pages = pageFiles.map(parsePage);
const pageUrls = new Set(pages.map((page) => page.url));

function frontmatterValue(page: Page, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(page.frontmatter);
  return match?.[1].trim().replace(/^["']|["']$/g, "");
}

describe("docs frontmatter", () => {
  it("sees the whole content tree, so the rest of this suite cannot pass vacuously", () => {
    expect(pages.length).toBeGreaterThan(50);
  });

  it("gives every page a title and a description", () => {
    const missing = pages
      .filter((page) => !frontmatterValue(page, "title") || !frontmatterValue(page, "description"))
      .map((page) => page.file);
    expect(missing, "every page needs `title` and `description` — both are search results").toEqual(
      []
    );
  });

  it("keeps descriptions short enough to survive a search snippet", () => {
    const tooLong = pages
      .map((page) => ({
        file: page.file,
        length: (frontmatterValue(page, "description") ?? "").length,
      }))
      .filter((page) => page.length > 160);
    expect(tooLong, "descriptions over 160 characters are truncated in results").toEqual([]);
  });
});

describe("docs links", () => {
  it("resolves every internal docs link to a real page", () => {
    const broken: string[] = [];
    // Markdown `](/docs/…)` and JSX `href="/docs/…"` both ship links; only checking one
    // let two dead `<Card href>` targets reach the built site.
    const patterns = [/\]\((\/docs[^)#\s]*)(?:#[^)\s]*)?\)/g, /href="(\/docs[^"#]*)(?:#[^"]*)?"/g];
    for (const page of pages) {
      for (const pattern of patterns) {
        for (const match of page.body.matchAll(pattern)) {
          const target = match[1].replace(/\/$/, "");
          if (!pageUrls.has(target)) broken.push(`${page.file} → ${match[1]}`);
        }
      }
    }
    expect(broken, "a moved page must take its inbound links with it").toEqual([]);
  });

  it("resolves every meta.json entry to a real page or folder", () => {
    const broken: string[] = [];
    for (const file of contentFiles.filter((file) => file.endsWith("meta.json"))) {
      const directory = dirname(join(ROOT, file));
      const entries: string[] = JSON.parse(readFileSync(join(ROOT, file), "utf8")).pages ?? [];
      for (const entry of entries) {
        // `---Label---` is a separator and `...` is the rest-spread token; neither is a page.
        if (entry.startsWith("---") || entry === "...") continue;
        const name = entry.replace(/^!/, "");
        const exists =
          existsSync(join(directory, `${name}.mdx`)) || existsSync(join(directory, name));
        if (!exists) broken.push(`${file} → ${entry}`);
      }
    }
    expect(broken, "a nav entry with no file silently vanishes from the sidebar").toEqual([]);
  });

  it("lists every page in its folder's meta.json, so nothing is unreachable", () => {
    const orphans: string[] = [];
    for (const page of pages) {
      const directory = dirname(join(ROOT, page.file));
      const name = page.file.replace(/^.*\//, "").replace(/\.mdx$/, "");
      // A folder's own index is its landing page; the parent nav links the folder, not the file.
      if (name === "index") continue;
      const meta = join(directory, "meta.json");
      if (!existsSync(meta)) {
        orphans.push(`${page.file} (no meta.json in its folder)`);
        continue;
      }
      const entries: string[] = JSON.parse(readFileSync(meta, "utf8")).pages ?? [];
      // `...` spreads in every unlisted sibling, so the folder cannot orphan anything.
      if (entries.includes("...")) continue;
      if (!entries.some((entry) => entry.replace(/^!/, "") === name)) orphans.push(page.file);
    }
    expect(orphans, "a page missing from meta.json ships but no reader can navigate to it").toEqual(
      []
    );
  });
});

/**
 * Claims are MDX comments so they never render, written as an MDX expression containing a
 * block comment: an opening `{`, then the comment, holding `tf-claim kind=… value="…"`.
 * The comment applies to the block that follows it.
 *
 * HTML comments are not an option: MDX rejects a bare `<!--` with a parse error, which is
 * exactly what left this guard dormant when it was first written.
 */
type Claim = { page: Page; kind: string; value: string };

function parseClaims(page: Page): Claim[] {
  return [...page.body.matchAll(/\{\/\*\s*tf-claim\s+([\s\S]*?)\*\/\}/g)].map((match) => {
    const attributes = match[1];
    const kind = /kind=([\w-]+)/.exec(attributes)?.[1] ?? "";
    const value = /value="([^"]*)"|value=([^\s]+)/.exec(attributes);
    return { page, kind, value: (value?.[1] ?? value?.[2] ?? "").trim() };
  });
}

const claims = pages.flatMap(parseClaims);

function directorySlugs(relativePath: string, marker: string): string[] {
  const base = join(ROOT, relativePath);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, marker)))
    .map((entry) => entry.name)
    .sort();
}

/** Each verifier returns the current truth, so a failure message can name the fix. */
const verifiers: Record<string, () => string> = {
  "integration-slugs": () => directorySlugs("integrations", "manifest.yml").join(","),
  "integration-count": () => String(directorySlugs("integrations", "manifest.yml").length),
};

describe("docs protected facts", () => {
  it("still carries claims, so the verifiers are not idling", () => {
    expect(
      claims.length,
      "no page carries a tf-claim, so every check below passes without testing anything"
    ).toBeGreaterThan(0);
  });

  it("uses only claim kinds this suite can verify", () => {
    const unknown = claims
      .filter((claim) => !(claim.kind in verifiers) && claim.kind !== "path-exists")
      .map((claim) => `${claim.page.file}: kind=${claim.kind || "(missing)"}`);
    expect(unknown, `known kinds: ${Object.keys(verifiers).join(", ")}, path-exists`).toEqual([]);
  });

  it("matches every claim against its source of truth", () => {
    const drifted: string[] = [];
    for (const claim of claims) {
      if (claim.kind === "path-exists") {
        if (!existsSync(join(ROOT, claim.value))) {
          drifted.push(`${claim.page.file}: path "${claim.value}" does not exist`);
        }
        continue;
      }
      const actual = verifiers[claim.kind]?.();
      if (actual !== undefined && actual !== claim.value) {
        drifted.push(
          `${claim.page.file}: ${claim.kind} claims "${claim.value}", source says "${actual}"`
        );
      }
    }
    expect(drifted, "update the prose, not the claim").toEqual([]);
  });
});

/**
 * Page blocks declare which track a page belongs to and which actions it needs. Like claims,
 * they are MDX comments carrying `tf-page: track: <track> requires: ["type:action", …]`.
 * Entries are `type:action`, matching the shape of ADMIN_ONLY_SURFACES.
 *
 * Naming a member-allowed surface asserts nothing today; it earns its keep when that surface
 * later moves into ADMIN_ONLY_SURFACES, at which point every page relying on it fails here.
 */
const ROLES = join(ROOT, "apps/api/src/identity/roles.ts");

/** type → allowed actions, where `*` means the whole surface is admin-only. */
function adminOnlySurfaces(): Map<string, Set<string>> {
  const source = readFileSync(ROLES, "utf8");
  const block = /const ADMIN_ONLY_SURFACES[^=]*=\s*\[(.*?)\n\];/s.exec(source)?.[1] ?? "";
  const surfaces = new Map<string, Set<string>>();
  for (const match of block.matchAll(/\{\s*type:\s*"([^"]+)",\s*actions:\s*\[([^\]]*)\]/gs)) {
    const actions = [...match[2].matchAll(/"([^"]+)"/g)].map((action) => action[1]);
    surfaces.set(match[1], new Set(actions));
  }
  return surfaces;
}

function violatesMemberAccess(required: string, surfaces: Map<string, Set<string>>): boolean {
  const [type, action] = required.includes(":") ? required.split(":", 2) : [required, "*"];
  const actions = surfaces.get(type);
  if (!actions) return false;
  return actions.has("*") || actions.has(action) || actions.has(`${type}.${action}`);
}

describe("docs track placement", () => {
  it("declares a track on every Using TulipFarm page", () => {
    const undeclared = pages
      .filter((page) => page.file.includes("using-tulipfarm/") && !page.file.endsWith("index.mdx"))
      .filter((page) => !/\{\/\*\s*tf-page:[\s\S]*?track:\s*using-tulipfarm/.test(page.body))
      .map((page) => page.file);
    expect(
      undeclared,
      "add an MDX comment under the frontmatter holding: tf-page: track: using-tulipfarm  " +
        'requires: ["chat:*"] — list the surface types the page asks the reader to use, taken ' +
        "from MEMBER_ALLOWED_SURFACES in apps/api/src/identity/roles.ts"
    ).toEqual([]);
  });

  it("keeps every Using TulipFarm page free of admin-only actions", () => {
    const surfaces = adminOnlySurfaces();
    const violations: string[] = [];
    for (const page of pages) {
      const block = /\{\/\*\s*tf-page:([\s\S]*?)\*\/\}/.exec(page.body)?.[1];
      if (!block) continue;
      if (/track:\s*([\w-]+)/.exec(block)?.[1] !== "using-tulipfarm") continue;
      for (const match of block.matchAll(/"([^"]+)"/g)) {
        if (violatesMemberAccess(match[1], surfaces)) {
          violations.push(
            `${page.file} requires "${match[1]}", which is admin-only in apps/api/src/identity/roles.ts`
          );
        }
      }
    }
    expect(
      violations,
      "move the page to Administration, or use only member-allowed actions"
    ).toEqual([]);
  });

  it("parses the admin surface catalog, so the invariant is not vacuous", () => {
    const surfaces = adminOnlySurfaces();
    expect(surfaces.size).toBeGreaterThan(5);
    // Two shapes must both parse: an explicit action list, and a whole-surface wildcard.
    expect(surfaces.get("secret")).toContain("secret.write");
    expect(surfaces.get("observability")).toContain("*");
  });

  /**
   * The Using TulipFarm track promises no terminal, no code and no admin access. Implementation
   * detail — REST paths, repo paths, shell blocks — breaks that promise silently, because the page
   * still renders and every link still resolves. Only a test catches it.
   */
  it("keeps implementation detail out of the Using TulipFarm track", () => {
    const banned: Array<[RegExp, string]> = [
      [/\/api\/v1\//, "a REST path — describe what the reader does on screen instead"],
      [/\b(?:apps|packages)\/[a-z-]+\/src\//, "a repo source path — readers cannot open it"],
      [/```(?:bash|sh|shell|console)/, "a shell block — this track has no terminal"],
    ];
    const violations: string[] = [];
    for (const page of pages) {
      if (!page.file.includes("/using-tulipfarm/")) continue;
      for (const [pattern, why] of banned) {
        const line = page.body.split("\n").findIndex((text) => pattern.test(text));
        if (line >= 0) violations.push(`${page.file}: ${why}`);
      }
    }
    expect(
      violations,
      "move the detail to reference/, or rewrite it as what the reader sees"
    ).toEqual([]);
  });
});

describe("api reference families", () => {
  /**
   * The endpoint families page names a base path per family. A base path that no longer exists
   * sends readers hunting for a route that was renamed or removed, which is how the previous
   * hand-typed catalogue rotted. Tags cannot be checked instead: several route files build them
   * from a variable, so there is no literal to match.
   */
  it("names only base paths that still exist in the api", () => {
    const page = readFileSync(join(ROOT, "apps/docs/content/docs/reference/api.mdx"), "utf8");
    const section = page.slice(page.indexOf("## Endpoint families"));

    const documented = new Set<string>();
    for (const row of section.split("\n")) {
      if (!row.startsWith("| `")) continue;
      const cells = row.split("|").map((cell) => cell.trim());
      for (const path of cells[2]?.matchAll(/`(\/[^`]*)`/g) ?? []) {
        documented.add(path[1].split("{")[0].replace(/\/$/, ""));
      }
    }
    expect(documented.size).toBeGreaterThan(30);

    const sources = execFileSync("git", ["ls-files", "--", "apps/api/src"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .map((file) => readFileSync(join(ROOT, file), "utf8"))
      .join("\n");

    const missing = [...documented].filter(
      (path) => !sources.includes(`"/api/v1${path}`) && !sources.includes(`"${path}`)
    );
    expect(missing, "documented base paths with no matching route").toEqual([]);
  });
});

describe("docs heading order", () => {
  /**
   * `Steps` and `Cards` render `h3`, so a page that opens one before its first `##` jumps the
   * document outline from `h1` straight to `h3`. Screen readers announce that as a missing level,
   * and the table of contents nests every later section under the first step.
   */
  it("never opens Steps or Cards before the first h2", () => {
    const offenders = pages.filter((page) => {
      const opener = Math.min(
        ...["<Steps>", "<Cards>"].map((tag) => {
          const at = page.body.indexOf(tag);
          return at === -1 ? Number.POSITIVE_INFINITY : at;
        })
      );
      if (opener === Number.POSITIVE_INFINITY) return false;
      return !/^## /m.test(page.body.slice(0, opener));
    });
    expect(offenders.map((page) => page.file)).toEqual([]);
  });
});
