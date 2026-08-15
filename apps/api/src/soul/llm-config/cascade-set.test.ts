import type { LlmService } from "@tulipfarm/llm";
import type { LlmConfig } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import {
  type CommitActor,
  type Logger,
  makeSoulWriterDouble,
  type SoulLoader,
} from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { makeLlmCascadeOnSecretSet } from "./cascade-set";

const ACTOR: CommitActor = { principalId: "user:u1", name: "Ada", email: "ada@example.com" };

function deps(llmConfig: LlmConfig | undefined = undefined) {
  const soulLoader = {
    llmConfig,
    reload: vi.fn(async () => {}),
  } as unknown as SoulLoader;
  const soul = makeSoulWriterDouble();
  const llmService = { init: vi.fn(async () => {}) } as unknown as LlmService;
  const secretsService = {} as unknown as SecretsService;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return { soul, soulLoader, llmService, secretsService, logger };
}

describe("makeLlmCascadeOnSecretSet", () => {
  it("auto-connects Claude Code with a tier per model on first token save", async () => {
    const d = deps(undefined);
    const triggerTaskReconcile = vi.fn(async () => {});
    const cascade = makeLlmCascadeOnSecretSet(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger,
      triggerTaskReconcile
    );

    await cascade("claude-code-oauth-token", ACTOR);

    expect(d.soul.applied).toHaveLength(1);
    expect(d.soul.applied[0]?.subject).toContain("Claude Code");
    expect(d.soul.applied[0]?.actor).toEqual(ACTOR);
    expect(d.soul.applied[0]?.changes).toEqual([
      { op: "put", target: { kind: "Settings" }, content: expect.stringContaining("claude-code") },
    ]);
    expect(d.llmService.init).toHaveBeenCalled();
    // The Task clears via the reconciler's next tick; kicking it here means the Companion reflects
    // the auto-connect within seconds instead of waiting up to 15 minutes for cron.
    expect(triggerTaskReconcile).toHaveBeenCalled();
  });

  it("auto-connects Codex on first auth.json save", async () => {
    const d = deps(undefined);
    const cascade = makeLlmCascadeOnSecretSet(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("codex-auth-json", ACTOR);

    expect(d.soul.applied).toHaveLength(1);
    expect(d.soul.applied[0]?.changes).toEqual([
      { op: "put", target: { kind: "Settings" }, content: expect.stringContaining("codex") },
    ]);
  });

  it("does nothing when tiers are already configured", async () => {
    const d = deps({
      tiers: {
        quick: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
        standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
        complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-6" }] },
      },
    });
    const cascade = makeLlmCascadeOnSecretSet(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("claude-code-oauth-token", ACTOR);

    expect(d.soul.applied).toHaveLength(0);
  });

  it("does nothing for a non-CLI provider secret (e.g. plain API key)", async () => {
    const d = deps(undefined);
    const cascade = makeLlmCascadeOnSecretSet(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("anthropic-api-key", ACTOR);

    expect(d.soul.applied).toHaveLength(0);
  });

  it("does nothing for an unrelated secret key", async () => {
    const d = deps(undefined);
    const cascade = makeLlmCascadeOnSecretSet(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("github-webhook-secret", ACTOR);

    expect(d.soul.applied).toHaveLength(0);
  });
});
