import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit from "simple-git";
import type { Logger } from "./types";

export class GitSyncService extends EventEmitter {
  constructor(
    private readonly soulPath: string,
    private readonly remoteUrl: string | undefined,
    private readonly credentials: string | undefined,
    private readonly logger: Logger
  ) {
    super();
  }

  private ensuring: Promise<void> | undefined;

  get path(): string {
    return this.soulPath;
  }

  /**
   * Guarantee `soulPath` is its OWN git repo before any commit. If it has no `.git` yet but sits
   * inside another repository, we REFUSE — committing there would silently pollute the enclosing
   * repo (e.g. a misconfigured relative SOUL_PATH landing inside the project tree). Otherwise we
   * initialize a dedicated repo. Idempotent.
   */
  private async ensureRepo(): Promise<void> {
    // Cache the in-flight init so concurrent commit()/withSync() calls don't both run
    // `git init` + addConfig (the previous boolean flag was set only after the awaits,
    // so two callers could race past it). On failure, clear the cache so a later call retries.
    this.ensuring ??= this.doEnsureRepo().catch((err) => {
      this.ensuring = undefined;
      throw err;
    });
    return this.ensuring;
  }

  private async doEnsureRepo(): Promise<void> {
    mkdirSync(this.soulPath, { recursive: true });

    if (!existsSync(join(this.soulPath, ".git"))) {
      let enclosing: string | null = null;
      try {
        enclosing = (await simpleGit(this.soulPath).revparse(["--show-toplevel"])).trim();
      } catch {
        enclosing = null; // not inside any git repo — safe to init a fresh one
      }
      if (enclosing && resolve(enclosing) !== resolve(this.soulPath)) {
        throw new Error(
          `Soul: SOUL_PATH "${this.soulPath}" is inside another git repository (${enclosing}). Point SOUL_PATH at a dedicated directory outside the project repo (e.g. ~/.tulipfarm/soul).`
        );
      }
      await simpleGit(this.soulPath).init();
      this.logger.info(`Soul: initialized git repo at ${this.soulPath}`);
    }

    const git = simpleGit(this.soulPath);
    await git.addConfig("user.name", BOT_GIT_NAME);
    await git.addConfig("user.email", BOT_GIT_EMAIL);
  }

  private authUrl(): string {
    if (!this.remoteUrl) return "";
    if (!this.credentials) return this.remoteUrl;
    return this.remoteUrl.replace("https://", `https://${this.credentials}@`);
  }

  async bootSync(): Promise<void> {
    if (!this.remoteUrl) {
      this.logger.info("Soul: no GIT_REMOTE_URL set, running in local-only mode");
      await this.ensureRepo();
      return;
    }
    const url = this.authUrl();
    if (!existsSync(join(this.soulPath, ".git"))) {
      this.logger.info(`Soul: cloning from remote into ${this.soulPath}`);
      await simpleGit()
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
  }

  private async pull(): Promise<void> {
    const git = simpleGit(this.soulPath);
    await git.remote(["set-url", "origin", this.authUrl()]);
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
    const git = simpleGit(this.soulPath);
    await git.add("-A");
    const result = await git.commit(message);
    return { sha: result.commit, filesChanged: result.summary.changes };
  }

  async push(): Promise<boolean> {
    if (!this.remoteUrl) return false;
    const git = simpleGit(this.soulPath);
    await git.remote(["set-url", "origin", this.authUrl()]);
    await git.push("origin", "main");
    return true;
  }

  /**
   * Commit then best-effort push (SOUL-V1-003). Push failure is logged, not thrown, but is
   * surfaced via `pushed` so callers/UI can distinguish a durable change from one committed
   * locally that a later `syncOnce()` may hard-reset away on genuine divergence (SOUL-V1-004).
   * `pushed` is `undefined` in local-only mode (no remote), `true`/`false` otherwise.
   */
  async withSync(
    message: string
  ): Promise<{ sha: string; filesChanged: number; pushed?: boolean }> {
    const result = await this.commit(message);
    if (!this.remoteUrl) return result;
    try {
      await this.push();
      return { ...result, pushed: true };
    } catch (err) {
      this.logger.warn(
        `Soul: withSync push failed — ${err instanceof Error ? err.message : String(err)}`
      );
      return { ...result, pushed: false };
    }
  }

  async syncOnce(): Promise<void> {
    if (!this.remoteUrl) return;
    try {
      await this.pull();
      this.logger.info("Soul: periodic sync complete");
      this.emit("soul.synced");
    } catch (err) {
      this.logger.error(
        `Soul: periodic sync failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
