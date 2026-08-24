import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { AssembleContext } from "@tulipfarm/agent-runtime";
import {
  buildSoulCatalogue,
  hermeticGitEnv,
  type SoulCatalogue,
  SoulLoader,
} from "@tulipfarm/soul";

/** The tracked fixture. Ordinary files, so it reviews and diffs like any other source. */
export const EVAL_SOUL_DIR = resolve(__dirname, "..", "soul");

export interface EvalSoul {
  /** A throwaway git checkout of the fixture. Never the tracked directory. */
  readonly path: string;
  readonly loader: SoulLoader;
  readonly catalogue: SoulCatalogue;
  /** sha256 over the fixture's contents. Folded into the Corpus version. */
  readonly hash: string;
  /**
   * Re-reads the checkout with a fresh `SoulLoader`, as the product does between Turns.
   *
   * A journey's later Turn must see what its earlier Turn committed, and the loader caches at
   * construction. Reloading here is what puts the real writer and the real loader on opposite
   * sides of one assertion — the seam where a Tool that commits a path the loader cannot read
   * looks like a success.
   */
  reload(): Promise<EvalSoul>;
  /** Removes the throwaway checkout. Safe to call twice. */
  dispose(): void;
}

/** Checkouts not yet disposed. Swept at exit so a crashed Sweep leaves no temp directories. */
const leaked = new Set<string>();
process.once("exit", () => {
  for (const path of leaked) rmSync(path, { recursive: true, force: true });
});

const SILENT = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function filesUnder(dir: string, root = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full, root)));
    else found.push(relative(root, full));
  }
  return found;
}

/**
 * Hash the fixture's contents, path by path.
 *
 * Paths are included and separators normalised: a file renamed but not edited changes what the
 * loader reads, and a hash over contents alone would call that the same Soul. Sorted, so the order
 * the filesystem happens to return entries in cannot move a Baseline.
 */
export async function evalSoulHash(dir: string): Promise<string> {
  const paths = (await filesUnder(dir)).sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path.split(sep).join("/"));
    digest.update("\0");
    digest.update(await readFile(join(dir, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/**
 * Copy the fixture into a throwaway git repository and load it with the real loader.
 *
 * Two reasons it is copied rather than read where it sits. The fixture cannot carry its own `.git`
 * without becoming a submodule of this repository, and the Soul writer L3 will exercise needs a
 * real repository to commit into — against the tracked directory those commits would dirty the
 * working tree of the harness being measured.
 */
export async function loadEvalSoul(source = EVAL_SOUL_DIR): Promise<EvalSoul> {
  const path = mkdtempSync(join(tmpdir(), "eval-soul-"));
  cpSync(source, path, { recursive: true });

  leaked.add(path);
  const dispose = () => {
    rmSync(path, { recursive: true, force: true });
    leaked.delete(path);
  };

  try {
    buildFixtureRepo(path);
  } catch (error) {
    dispose();
    throw error;
  }

  const loader = new SoulLoader(path, SILENT);
  await loader.load();

  const hash = await evalSoulHash(source);
  const view = async (): Promise<EvalSoul> => {
    const reloaded = new SoulLoader(path, SILENT);
    await reloaded.load();
    return {
      path,
      loader: reloaded,
      catalogue: buildSoulCatalogue(reloaded),
      hash,
      dispose,
      reload: view,
    };
  };

  return {
    path,
    loader,
    catalogue: buildSoulCatalogue(loader),
    hash,
    dispose,
    reload: view,
  };
}

/**
 * `git init` plus one commit, with the host's Git environment stripped.
 *
 * `hermeticGitEnv` is not optional here: an exported `GIT_DIR` — which every Git hook, `rebase
 * --exec` and `bisect run` sets — would redirect these commands at the maintainer's own repository
 * and commit the fixture into it. Signing is disabled for the same class of reason: a machine with
 * `commit.gpgsign` on by default would otherwise fail to build a throwaway repo nobody will read.
 */
function buildFixtureRepo(path: string): void {
  const git = (...args: string[]) => {
    try {
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: path,
        env: hermeticGitEnv(),
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(
        `Eval Soul: could not build its throwaway git repository — \`git ${args.join(" ")}\` failed` +
          (stderr ? `: ${stderr}` : ".")
      );
    }
  };
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "eval@tulipfarm.invalid");
  git("config", "user.name", "TulipFarm Eval");
  git("add", "-A");
  git("commit", "--quiet", "-m", "Eval Soul fixture");
}

/**
 * The Context fields the Eval Soul owns.
 *
 * `soulContext` returns exactly these — the compiler rejects a field it supplies but does not
 * list, and the Corpus refuses a Case that sets one. Restating the list in the Corpus guard was
 * how a Soul-supplied field came to be overridable by a Case.
 */
export const SOUL_OWNED_CONTEXT_KEYS = ["personality"] as const;

type SoulOwnedContext = Pick<AssembleContext, (typeof SOUL_OWNED_CONTEXT_KEYS)[number]>;

/**
 * The part of the Context an Agent owns, taken from the Eval Soul.
 *
 * The mapping is production's (`apps/api/src/chat/system-prompt.ts`) and must stay production's —
 * an eval that assembled its Agent differently would measure a prompt no real turn ever sees. The
 * AGENT.md body is the `personality` block, and it is the only thing the Soul contributes to a
 * prompt: everything else an Agent knows now arrives through a Tool.
 *
 * @throws when the Case names an Agent the Eval Soul does not define.
 */
export function soulContext(soul: EvalSoul, agentName: string): SoulOwnedContext {
  const agent = soul.loader.agents.get(agentName);
  if (agent === undefined) {
    const known = [...soul.loader.agents.keys()].sort().join(", ");
    throw new Error(`Eval Soul defines no Agent "${agentName}" — it defines: ${known}`);
  }
  return { personality: agent.body };
}
