/**
 * A Tool that writes to the Eval Soul's real git repository.
 *
 * TulipFarm's promise is that an agent asked to change the business's configuration does so by
 * committing to the Soul. L2 cannot check that at all — it fakes every Tool result — so a Case
 * that claims an agent configured something is, at L2, only checking that it said it had.
 *
 * The Tool wrapper is this app's, because the real ones live in `apps/api` and an app may not
 * import another app. Everything under it is production's: the real `SoulWriter` validating the
 * changeset, the real `SoulGitStore` committing it, the real signer covering the commit. Those are
 * where a regression would live.
 */

import { execFileSync } from "node:child_process";
import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  createHmacCommitSigner,
  hermeticGitEnv,
  SoulGitStore,
  SoulWriteError,
  SoulWriter,
} from "@tulipfarm/soul";
import type { EvalSoul } from "../eval-soul.ts";

export const SOUL_WRITE_TOOL = "soul_write";

/** What one accepted write committed, as a Case can assert on it. */
export interface SoulCommit {
  readonly sha: string;
  readonly message: string;
  readonly paths: readonly string[];
}

export interface SoulWriterTool {
  readonly port: ToolDispatchPort;
  /** Commits this Trial landed, in order. Empty means the Turn changed no configuration. */
  readonly commits: readonly SoulCommit[];
  /**
   * Returns the fixture to the commit it was loaded at.
   *
   * A Soul is loaded once per Sweep and every L3 Trial commits into the same repository, so without
   * this the second Trial would start from whatever the first one wrote — and a Case asserting an
   * Agent was created would pass because a previous Case created it.
   */
  reset(): void;
}

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

interface WriteArguments {
  readonly kind?: unknown;
  readonly slug?: unknown;
  readonly content?: unknown;
  readonly companion?: unknown;
  readonly definitionMode?: unknown;
  readonly subject?: unknown;
}

/**
 * The Tool the L3 tier exposes for Soul writes.
 *
 * Deliberately narrow: it puts one artifact's definition file, or one companion file beside it.
 * Reproducing the API's full Agent and Skill Tool surface here would be a second implementation of
 * the product's own Tools, and a Case passing against it would prove nothing about the ones users
 * reach. A companion is included because a Skill is a *package* — its prose, references and scripts
 * are the artifact as much as its definition is, and a writer that can only address the definition
 * cannot measure whether the rest of the package survives.
 */
export function soulWriterTool(soul: EvalSoul): SoulWriterTool {
  const commits: SoulCommit[] = [];
  // `hermeticGitEnv` is not optional. An exported GIT_DIR — which every Git hook, `rebase --exec`
  // and `bisect run` sets — overrides `cwd` entirely, so without it `base` would be the
  // maintainer's own HEAD and `reset` would `git reset --hard` and `git clean -fd` their checkout,
  // destroying uncommitted work. `reset` runs in a `finally` on every Trial, including failing ones.
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: soul.path, env: hermeticGitEnv() }).toString();
  const base = git("rev-parse", "HEAD").trim();
  const store = new SoulGitStore(
    soul.path,
    createHmacCommitSigner("eval", "eval-soul-commit-key"),
    SILENT
  );
  // No push port and no publisher: the fixture repo has no remote, and a bundle publish would need
  // the API's signing stack. Neither decides whether the commit landed, which is what L3 measures.
  const writer = new SoulWriter(store, SILENT, undefined, { reload: () => soul.loader.load() });

  return {
    commits,
    reset: () => {
      git("reset", "--hard", base);
      git("clean", "-fd");
    },
    port: {
      dispatch: async (call) => {
        if (call.name !== SOUL_WRITE_TOOL) {
          return { status: "failed", callId: call.callId, reason: `unknown Tool ${call.name}` };
        }
        const args = (call.arguments ?? {}) as WriteArguments;
        const kind = typeof args.kind === "string" ? args.kind : undefined;
        const slug = typeof args.slug === "string" ? args.slug : undefined;
        const content = typeof args.content === "string" ? args.content : undefined;
        const companion = typeof args.companion === "string" ? args.companion : undefined;
        const definitionMode =
          args.definitionMode === "canonical" || args.definitionMode === "legacy"
            ? args.definitionMode
            : "legacy";
        if (kind === undefined || slug === undefined || content === undefined) {
          return {
            status: "invalid_arguments",
            callId: call.callId,
            reason: "soul_write needs string kind, slug and content",
          };
        }

        try {
          const result = await writer.apply({
            subject:
              typeof args.subject === "string" && args.subject.length > 0
                ? args.subject
                : `soul: update ${kind} ${slug}`,
            source: "agent",
            actor: { principalId: "agent:eval", name: "Eval", email: "eval@tulipfarm.local" },
            businessId: "eval",
            changes: [
              {
                op: "put",
                target:
                  companion === undefined
                    ? { kind: kind as never, slug, definitionMode }
                    : { kind: kind as never, slug, companion },
                content,
              },
            ],
          });
          commits.push({ sha: result.commitSha, message: `${kind} ${slug}`, paths: result.paths });
          return {
            status: "succeeded",
            callId: call.callId,
            output: { commit: result.commitSha, paths: result.paths },
          };
        } catch (cause) {
          // A rejected write is a legitimate result the model must handle, not a tier failure: the
          // writer refusing an invalid artifact is exactly the behaviour a Case may be asserting.
          if (cause instanceof SoulWriteError) {
            // The issues, not just the count. A denial reading "1 issue" tells a Case author
            // nothing, and the model is expected to recover from this text.
            const issues = cause.issues
              .map((issue) =>
                issue.field === undefined
                  ? `${issue.code} at ${issue.path}`
                  : `${issue.code} at ${issue.path}.${issue.field}`
              )
              .join("; ");
            return {
              status: "denied",
              callId: call.callId,
              reason:
                issues.length === 0
                  ? `${cause.code}: ${cause.message}`
                  : `${cause.code}: ${cause.message} — ${issues}`,
            };
          }
          throw cause;
        }
      },
    },
  };
}
