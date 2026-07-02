import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit from "simple-git";
import type { Logger } from "./types";

// Never let git block on an interactive username/password prompt (e.g. a bad/missing credential
// against a private remote) — without this, a clone/fetch over HTTPS can hang indefinitely
// instead of failing fast, which is what made the setup wizard's "Saving…" spin forever.
process.env.GIT_TERMINAL_PROMPT ??= "0";

const GIT_TIMEOUT_MS = 30_000;

export class GitSyncService extends EventEmitter {
  constructor(
    private readonly soulPath: string,
    private remoteUrl: string | undefined,
    private credentials: string | undefined,
    private readonly logger: Logger
  ) {
    super();
  }

  private ensured = false;
  private lastSyncError: string | null = null;
  private lastSyncAt: Date | null = null;

  /** `simpleGit` bound to `soulPath` with a hard timeout, so a hung/blocking git process
   * (network stall, unexpected credential prompt) fails after `GIT_TIMEOUT_MS` instead of
   * hanging the request forever. */
  private gitAt() {
    return simpleGit(this.soulPath, { timeout: { block: GIT_TIMEOUT_MS } });
  }

  get path(): string {
    return this.soulPath;
  }

  hasRemote(): boolean {
    return this.remoteUrl !== undefined && this.remoteUrl !== "";
  }

  /**
   * Guarantee `soulPath` is its OWN git repo before any commit. If it has no `.git` yet but sits
   * inside another repository, we REFUSE — committing there would silently pollute the enclosing
   * repo (e.g. a misconfigured relative SOUL_PATH landing inside the project tree). Otherwise we
   * initialize a dedicated repo. Idempotent.
   */
  private async ensureRepo(): Promise<void> {
    if (this.ensured) return;
    mkdirSync(this.soulPath, { recursive: true });

    if (!existsSync(join(this.soulPath, ".git"))) {
      let enclosing: string | null = null;
      try {
        enclosing = (await this.gitAt().revparse(["--show-toplevel"])).trim();
      } catch {
        enclosing = null; // not inside any git repo — safe to init a fresh one
      }
      if (enclosing && resolve(enclosing) !== resolve(this.soulPath)) {
        throw new Error(
          `Soul: SOUL_PATH "${this.soulPath}" is inside another git repository (${enclosing}). Point SOUL_PATH at a dedicated directory outside the project repo (e.g. ~/.tulipfarm/soul).`
        );
      }
      await this.gitAt().init();
      this.logger.info(`Soul: initialized git repo at ${this.soulPath}`);
    }

    const git = this.gitAt();
    await git.addConfig("user.name", BOT_GIT_NAME);
    await git.addConfig("user.email", BOT_GIT_EMAIL);
    this.ensured = true;
  }

  private authUrl(): string {
    if (!this.remoteUrl) return "";
    if (!this.credentials) return this.remoteUrl;
    return this.remoteUrl.replace("https://", `https://${this.credentials}@`);
  }

  async bootSync(): Promise<void> {
    if (!this.remoteUrl) {
      this.logger.info("Soul: no SOUL_GIT_REMOTE_URL set, running in local-only mode");
      await this.ensureRepo();
      return;
    }
    await this.syncWithRemote();
  }

  /** Manual, user-triggered sync (Settings → Soul "Sync now"). Throws on failure — same
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
    const url = this.authUrl();
    try {
      if (!existsSync(join(this.soulPath, ".git"))) {
        this.logger.info(`Soul: cloning from remote into ${this.soulPath}`);
        await simpleGit({ timeout: { block: GIT_TIMEOUT_MS } })
          .outputHandler((_cmd, stdout, stderr) => {
            stdout.pipe(process.stdout);
            stderr.pipe(process.stderr);
          })
          .clone(url, this.soulPath);
        this.logger.info("Soul: clone complete");
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
  private async remoteHasMain(git: ReturnType<typeof this.gitAt>): Promise<boolean> {
    const heads = await git.listRemote(["--heads", "origin", "main"]);
    return heads.trim() !== "";
  }

  /** Point `origin` at `url` — `set-url` if it already exists, else `add` (e.g. a repo that
   * booted local-only never had an `origin` to point). */
  private async ensureRemote(url: string): Promise<void> {
    const git = this.gitAt();
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
  async configureRemote(remoteUrl: string, credentials?: string): Promise<void> {
    this.remoteUrl = remoteUrl;
    this.credentials = credentials;
    await this.ensureRepo();
    await this.bootSync();
  }

  /** Read-only sync status for display (Settings → Soul). Never throws — a fetch failure
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

    const git = this.gitAt();
    let headSha: string | null;
    try {
      headSha = (await git.revparse(["HEAD"])).trim();
    } catch {
      headSha = null; // no commits yet
    }

    if (!remoteConfigured) {
      return { remoteConfigured, ahead: 0, behind: 0, headSha, ...base };
    }

    try {
      await this.ensureRemote(this.authUrl());
      if (!(await this.remoteHasMain(git))) {
        this.lastSyncError = null;
        this.lastSyncAt = new Date();
        return {
          remoteConfigured,
          remoteUrl: this.remoteUrl,
          ahead: 0,
          behind: 0,
          headSha,
          lastSyncError: null,
          lastSyncAt: this.lastSyncAt.toISOString(),
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

  private async pull(): Promise<void> {
    const git = this.gitAt();
    await this.ensureRemote(this.authUrl());

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

  async commit(message: string): Promise<{ sha: string; filesChanged: number }> {
    await this.ensureRepo();
    const git = this.gitAt();
    await git.add("-A");
    const result = await git.commit(message);
    return { sha: result.commit, filesChanged: result.summary.changes };
  }

  async push(): Promise<boolean> {
    if (!this.remoteUrl) return false;
    const git = this.gitAt();
    await git.remote(["set-url", "origin", this.authUrl()]);
    await git.push("origin", "main");
    return true;
  }

  /** Commit then best-effort push (SOUL-V1-003). Push failure is logged, not thrown. */
  async withSync(message: string): Promise<{ sha: string; filesChanged: number }> {
    const result = await this.commit(message);
    if (this.remoteUrl) {
      try {
        await this.push();
      } catch (err) {
        this.logger.warn(
          `Soul: withSync push failed — ${err instanceof Error ? err.message : String(err)}`
        );
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
