import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit from "simple-git";
import type { CommitActor } from "./commit-signing";
import { hermeticGitEnv } from "./git-env";
import { scaffoldSoul } from "./scaffold-soul";
import type { Logger } from "./types";

// Never let git block on an interactive username/password prompt (e.g. a bad/missing credential
// against a private remote) — without this, a clone/fetch over HTTPS can hang indefinitely
// instead of failing fast, which is what made the setup wizard's "Saving…" spin forever.
process.env.GIT_TERMINAL_PROMPT ??= "0";

const GIT_TIMEOUT_MS = 30_000;

/** Resolves the current git credential (e.g. a PAT or GitHub App installation token) fresh on
 * every call — never cached by the caller, since installation tokens expire hourly. */
export type CredentialProvider = () => Promise<string | undefined>;

export interface SoulCommittedTreePublisher {
  publishCommittedTree(input: { commitSha: string; actor: CommitActor }): Promise<void>;
}

export interface GitSyncServiceOptions {
  readonly committedTreePublisher?: SoulCommittedTreePublisher;
  readonly defaultCommitActor?: () => CommitActor | undefined;
}

export class GitSyncService extends EventEmitter {
  constructor(
    private readonly soulPath: string,
    private remoteUrl: string | undefined,
    private credentialProvider: CredentialProvider,
    private readonly logger: Logger,
    private readonly options: GitSyncServiceOptions = {}
  ) {
    super();
  }

  private ensured = false;
  private lastSyncError: string | null = null;
  private lastSyncAt: Date | null = null;

  /** Pass credentials as transient HTTP headers; never persist tokens in `.git/config`. */
  private async authConfig(): Promise<string[]> {
    if (!this.remoteUrl) return [];
    const credential = await this.credentialProvider();
    if (!credential) return [];
    const basic = Buffer.from(`x-access-token:${credential}`).toString("base64");
    return [`http.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  /** `simpleGit` bound to `soulPath` with a hard timeout, so a hung/blocking git process
   * (network stall, unexpected credential prompt) fails after `GIT_TIMEOUT_MS` instead of
   * hanging the request forever. The credential (if any) is applied as a per-instance
   * `http.extraheader` config override rather than being written into the stored remote URL. */
  private async gitAt() {
    const config = await this.authConfig();
    return simpleGit(this.soulPath, {
      timeout: { block: GIT_TIMEOUT_MS },
      ...(config.length > 0 ? { config } : {}),
    }).env(hermeticGitEnv());
  }

  get path(): string {
    return this.soulPath;
  }

  hasRemote(): boolean {
    return this.remoteUrl !== undefined && this.remoteUrl !== "";
  }

  /** Ensure `soulPath` is its own repo; refuse nested repos to avoid polluting the project repo. */
  private async ensureRepo(): Promise<void> {
    if (this.ensured) return;
    mkdirSync(this.soulPath, { recursive: true });

    if (!existsSync(join(this.soulPath, ".git"))) {
      let enclosing: string | null = null;
      try {
        enclosing = (await (await this.gitAt()).revparse(["--show-toplevel"])).trim();
      } catch {
        enclosing = null; // not inside any git repo — safe to init a fresh one
      }
      if (enclosing && resolve(enclosing) !== resolve(this.soulPath)) {
        throw new Error(
          `Soul: SOUL_PATH "${this.soulPath}" is inside another git repository (${enclosing}). Point SOUL_PATH at a dedicated directory outside the project repo (e.g. ~/.tulipfarm/soul).`
        );
      }
      // Explicit branch name: git's compiled-in default is still `master`, so without this the
      // branch a fresh Soul repo gets depends on whether the host happens to set
      // `init.defaultBranch`. The rest of the system (remote sync, publication) speaks `main`.
      await (await this.gitAt()).init(["--initial-branch=main"]);
      this.logger.info(`Soul: initialized git repo at ${this.soulPath}`);
    }

    const git = await this.gitAt();
    await git.addConfig("user.name", BOT_GIT_NAME);
    await git.addConfig("user.email", BOT_GIT_EMAIL);
    this.ensured = true;

    if (!(await this.hasCommits(git))) {
      this.logger.info(
        `Soul: ${this.soulPath} has no commits yet — scaffolding initial soul structure`
      );
      await scaffoldSoul(this.soulPath);
    }
  }

  private async hasCommits(git: Awaited<ReturnType<typeof this.gitAt>>): Promise<boolean> {
    return git
      .revparse(["HEAD"])
      .then(() => true)
      .catch(() => false);
  }

  async bootSync(): Promise<void> {
    if (!this.remoteUrl) {
      this.logger.info("Soul: no SOUL_GIT_REMOTE_URL set, running in local-only mode");
      await this.ensureRepo();
      return;
    }
    await this.syncWithRemote();
  }

  /** Manual, user-triggered sync (Business → Soul "Sync now"). Throws on failure — same
   * contract as `bootSync`/`configureRemote` — so the route can surface the error. */
  async syncNow(): Promise<void> {
    if (!this.remoteUrl) {
      throw new Error("no git remote configured");
    }
    await this.syncWithRemote();
  }

  /** Clone-or-pull against `remoteUrl`, recording the outcome (`lastSyncError`/`lastSyncAt`) for
   * status display regardless of success or failure. Always rethrows on failure — callers decide
   * whether that's fatal (`configureRemote`/`syncNow`) or swallowed (boot). */
  private async syncWithRemote(): Promise<void> {
    const remoteUrl = this.remoteUrl;
    if (remoteUrl === undefined) return;
    const config = await this.authConfig();
    try {
      if (!existsSync(join(this.soulPath, ".git"))) {
        this.logger.info(`Soul: cloning from remote into ${this.soulPath}`);
        await simpleGit({
          timeout: { block: GIT_TIMEOUT_MS },
          ...(config.length > 0 ? { config } : {}),
        })
          .env(hermeticGitEnv())
          .outputHandler((_cmd, stdout, stderr) => {
            stdout.pipe(process.stdout);
            stderr.pipe(process.stderr);
          })
          .clone(remoteUrl, this.soulPath);
        this.logger.info("Soul: clone complete");

        const git = await this.gitAt();
        await git.addConfig("user.name", BOT_GIT_NAME);
        await git.addConfig("user.email", BOT_GIT_EMAIL);
        this.ensured = true;
        if (!(await this.hasCommits(git))) {
          this.logger.info("Soul: cloned an empty remote — scaffolding initial soul structure");
          await scaffoldSoul(this.soulPath);
          await git.push("origin", "main");
          this.logger.info("Soul: pushed initial soul structure to origin/main");
        }
      } else {
        this.logger.info("Soul: pulling from origin/main");
        await this.pull();
        this.logger.info("Soul: synced from origin/main");
      }
      this.lastSyncError = null;
      this.lastSyncAt = new Date();
    } catch (err) {
      this.lastSyncError = err instanceof Error ? err.message : String(err);
      this.lastSyncAt = new Date();
      throw err;
    }
  }

  /** A brand-new GitHub repo has no branches at all until something is pushed — `main` doesn't
   * exist on `origin` yet. Fetching/diffing against it would fail with "couldn't find remote ref
   * main", so callers check this first and push to initialize the branch instead. */
  private async remoteHasMain(git: Awaited<ReturnType<typeof this.gitAt>>): Promise<boolean> {
    const heads = await git.listRemote(["--heads", "origin", "main"]);
    return heads.trim() !== "";
  }

  /** Point `origin` at `url` — `set-url` if it already exists, else `add` (e.g. a repo that
   * booted local-only never had an `origin` to point). `url` is always the plain remote URL —
   * credentials are never embedded in it (see `authConfig`), so `.git/config` never stores a
   * live credential. */
  private async ensureRemote(url: string): Promise<void> {
    const git = await this.gitAt();
    const remotes = await git.getRemotes();
    if (remotes.some((r) => r.name === "origin")) {
      await git.remote(["set-url", "origin", url]);
    } else {
      await git.remote(["add", "origin", url]);
    }
  }

  /** Live-reconfigure the remote/credentials and sync immediately (SOUL setup wizard) — no
   * restart required, unlike the boot-time env vars this instance was originally constructed
   * with. Reuses `bootSync`'s `pull` branch, which now works whether or not `origin` already
   * existed (see `ensureRemote`). */
  async configureRemote(remoteUrl: string, credentialProvider: CredentialProvider): Promise<void> {
    this.remoteUrl = remoteUrl;
    this.credentialProvider = credentialProvider;
    await this.ensureRepo();
    await this.bootSync();
  }

  /** Read-only sync status for display (Business → Soul). Never throws — a fetch failure
   * (offline, bad credential) degrades ahead/behind to 0, but is recorded as `lastSyncError` so
   * the UI can show it rather than silently reporting "up to date". */
  async getStatus(): Promise<{
    remoteConfigured: boolean;
    remoteUrl?: string;
    ahead: number;
    behind: number;
    headSha: string | null;
    lastSyncError: string | null;
    lastSyncAt: string | null;
  }> {
    const remoteConfigured = this.hasRemote();
    const base = {
      lastSyncError: this.lastSyncError,
      lastSyncAt: this.lastSyncAt ? this.lastSyncAt.toISOString() : null,
    };
    if (!existsSync(join(this.soulPath, ".git"))) {
      return {
        remoteConfigured,
        remoteUrl: this.remoteUrl,
        ahead: 0,
        behind: 0,
        headSha: null,
        ...base,
      };
    }

    const git = await this.gitAt();
    let headSha: string | null;
    try {
      headSha = (await git.revparse(["HEAD"])).trim();
    } catch {
      headSha = null; // no commits yet
    }

    const remoteUrl = this.remoteUrl;
    if (!remoteConfigured || remoteUrl === undefined) {
      return { remoteConfigured, ahead: 0, behind: 0, headSha, ...base };
    }

    try {
      await this.ensureRemote(remoteUrl);
      if (!(await this.remoteHasMain(git))) {
        // The remote branch doesn't exist yet — either nothing has been pushed at all, or an
        // earlier push (e.g. the empty-clone scaffold-then-push in `syncWithRemote`) failed and
        // left commits sitting local-only. Report the real local-ahead count instead of a
        // hardcoded 0, and leave `lastSyncError`/`lastSyncAt` as whatever the last actual sync
        // attempt recorded — this call doesn't attempt a push, so it must not clear a real error.
        const ahead = headSha !== null ? await this.localCommitCount(git) : 0;
        return {
          remoteConfigured,
          remoteUrl: this.remoteUrl,
          ahead,
          behind: 0,
          headSha,
          ...base,
        };
      }
      await git.fetch("origin", "main");
      const counts = await git.raw(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
      const [aheadStr, behindStr] = counts.trim().split(/\s+/);
      this.lastSyncError = null;
      this.lastSyncAt = new Date();
      return {
        remoteConfigured,
        remoteUrl: this.remoteUrl,
        ahead: Number.parseInt(aheadStr, 10),
        behind: Number.parseInt(behindStr, 10),
        headSha,
        lastSyncError: null,
        lastSyncAt: this.lastSyncAt.toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Soul: status fetch failed — ${message}`);
      this.lastSyncError = message;
      this.lastSyncAt = new Date();
      return {
        remoteConfigured,
        remoteUrl: this.remoteUrl,
        ahead: 0,
        behind: 0,
        headSha,
        lastSyncError: message,
        lastSyncAt: this.lastSyncAt.toISOString(),
      };
    }
  }

  private async localCommitCount(git: Awaited<ReturnType<typeof this.gitAt>>): Promise<number> {
    const out = await git.raw(["rev-list", "--count", "HEAD"]);
    return Number.parseInt(out.trim(), 10);
  }

  /** Current HEAD sha, or `undefined` when the repo has no commits yet. Pure local read — no fetch. */
  async headSha(): Promise<string | undefined> {
    const git = await this.gitAt();
    return git
      .revparse(["HEAD"])
      .then((sha) => sha.trim())
      .catch(() => undefined);
  }

  /** Latest commit date for each requested file, read from the local Soul history in one git call. */
  async lastCommitDates(relativePaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const dates = new Map<string, string>();
    if (relativePaths.length === 0) return dates;

    const git = await this.gitAt();
    if (!(await this.hasCommits(git))) return dates;

    const requested = new Set(relativePaths);
    const output = await git.raw([
      "log",
      "--format=__TULIP_COMMIT__%cI",
      "--name-only",
      "--",
      ...relativePaths,
    ]);
    let committedAt: string | undefined;
    for (const line of output.split("\n")) {
      if (line.startsWith("__TULIP_COMMIT__")) {
        committedAt = line.slice("__TULIP_COMMIT__".length);
      } else if (committedAt && requested.has(line) && !dates.has(line)) {
        dates.set(line, committedAt);
      }
    }
    return dates;
  }

  /** Whether `sha` still resolves to a commit object in this repo. */
  async hasCommit(sha: string): Promise<boolean> {
    const git = await this.gitAt();
    return git
      .raw(["cat-file", "-e", `${sha}^{commit}`])
      .then(() => true)
      .catch(() => false);
  }

  private async pull(): Promise<void> {
    const remoteUrl = this.remoteUrl;
    if (remoteUrl === undefined) return;
    const git = await this.gitAt();
    await this.ensureRemote(remoteUrl);

    if (!(await this.remoteHasMain(git))) {
      const hasCommits = await git
        .revparse(["HEAD"])
        .then(() => true)
        .catch(() => false);
      if (hasCommits) {
        this.logger.info("Soul: remote has no main branch yet — pushing to initialize it");
        await git.push("origin", "main");
        this.logger.info("Soul: pushed to initialize origin/main");
      }
      return;
    }

    await git.fetch("origin", "main");

    const counts = await git.raw(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
    const [aheadStr, behindStr] = counts.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadStr, 10);
    const behind = Number.parseInt(behindStr, 10);

    if (behind === 0) {
      if (ahead > 0) {
        this.logger.info(`Soul: local is ${ahead} commit(s) ahead — keeping local, retrying push`);
        try {
          await git.push("origin", "main");
          this.logger.info("Soul: pushed local commits to origin/main");
        } catch (err) {
          this.logger.warn(
            `Soul: push failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return;
    }

    if (ahead > 0) {
      // Genuine divergence — upstream wins per SOUL-V1-004
      const dirty = await git.raw(["status", "--porcelain"]);
      if (dirty.trim().length > 0) {
        throw new Error(
          "Soul: refusing to hard-reset a divergent repository with uncommitted work; commit or remove the local edits first"
        );
      }
      const discarded = await git.raw(["log", "--oneline", "origin/main..HEAD"]);
      this.logger.warn(
        `Soul: genuine divergence detected — discarding ${ahead} local commit(s):\n${discarded.trim()}`
      );
      await git.reset(["--hard", "origin/main"]);
      this.logger.info("Soul: hard-reset to origin/main");
      return;
    }

    // behind > 0, ahead === 0: safe fast-forward
    await git.pull("origin", "main", ["--ff-only"]);
  }

  /**
   * Commit an explicit list of paths. This is the only commit primitive: it stages the paths it is
   * given by name, so a commit can never sweep in unrelated worktree state. The `git add -A`
   * variants it replaced were removed with ADR-007 — see `scripts/soul-write-gateway.test.ts`.
   */
  async commitPaths(
    message: string,
    paths: readonly string[],
    actor?: CommitActor
  ): Promise<{ sha: string; filesChanged: number }> {
    if (
      paths.length === 0 ||
      paths.some((path) => path.startsWith("/") || path.split("/").includes(".."))
    ) {
      throw new Error("Soul: commit paths must be non-empty relative paths");
    }
    await this.ensureRepo();
    const git = await this.gitAt();
    const changedPaths: string[] = [];
    for (const path of paths) {
      const status = await git.raw(["status", "--porcelain", "--", path]);
      if (status.trim().length === 0) continue;
      await git.add(["-A", "--", path]);
      changedPaths.push(path);
    }
    if (changedPaths.length === 0) throw new Error("Soul: no migration-owned changes to commit");
    const result = await git.commit(message, changedPaths);
    const committed = { sha: result.commit, filesChanged: result.summary.changes };
    await this.afterSuccessfulCommit(committed, actor);
    return committed;
  }

  /** Every successful commit helper must call this hook so bundle publication cannot be bypassed. */
  private async afterSuccessfulCommit(
    result: { sha: string; filesChanged: number },
    actor: CommitActor | undefined
  ): Promise<void> {
    if (result.sha.length === 0 || result.filesChanged === 0) return;
    const publisher = this.options.committedTreePublisher;
    if (publisher === undefined) return;
    const resolvedActor = actor ?? this.options.defaultCommitActor?.();
    if (resolvedActor === undefined) {
      this.logger.error(
        `Soul: committed ${result.sha} but skipped bundle publication because no commit actor was supplied`
      );
      return;
    }
    try {
      await publisher.publishCommittedTree({ commitSha: result.sha, actor: resolvedActor });
    } catch (err) {
      this.logger.error(
        `Soul: committed ${result.sha} but bundle publication failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async push(): Promise<boolean> {
    const remoteUrl = this.remoteUrl;
    if (remoteUrl === undefined) return false;
    await this.ensureRemote(remoteUrl);
    const git = await this.gitAt();
    await git.push("origin", "main");
    return true;
  }

  /** Commit then best-effort push (SOUL-V1-003). Push failure is logged, not thrown. */
  /** `commitPaths` plus a best-effort push. The only way a Soul commit reaches the remote. */
  async withSyncPaths(
    message: string,
    paths: readonly string[],
    actor?: CommitActor
  ): Promise<{ sha: string; filesChanged: number }> {
    const result = await this.commitPaths(message, paths, actor);
    if (this.remoteUrl) {
      try {
        await this.push();
      } catch (err) {
        this.logger.warn(`Soul: push failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  async syncOnce(): Promise<void> {
    if (!this.remoteUrl) return;
    try {
      await this.pull();
      this.lastSyncError = null;
      this.lastSyncAt = new Date();
      this.logger.info("Soul: periodic sync complete");
      this.emit("soul.synced");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastSyncError = message;
      this.lastSyncAt = new Date();
      this.logger.error(`Soul: periodic sync failed — ${message}`);
    }
  }
}
