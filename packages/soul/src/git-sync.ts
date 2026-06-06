import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit from "simple-git";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export class GitSyncService extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly soulPath: string,
    private readonly remoteUrl: string | undefined,
    private readonly credentials: string | undefined,
    private readonly logger: Logger
  ) {
    super();
  }

  private authUrl(): string {
    if (!this.remoteUrl) return "";
    if (!this.credentials) return this.remoteUrl;
    return this.remoteUrl.replace("https://", `https://${this.credentials}@`);
  }

  async bootSync(): Promise<void> {
    if (!this.remoteUrl) {
      this.logger.info("Soul: no GIT_REMOTE_URL set, running in local-only mode");
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
    const git = simpleGit(this.soulPath);
    await git.addConfig("user.name", BOT_GIT_NAME);
    await git.addConfig("user.email", BOT_GIT_EMAIL);
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

  startPeriodicSync(intervalMs: number): void {
    this.timer = setInterval(async () => {
      try {
        await this.pull();
        this.logger.info("Soul: periodic sync complete");
      } catch (err) {
        this.logger.error(
          `Soul: periodic sync failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, intervalMs);
  }

  stopPeriodicSync(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
