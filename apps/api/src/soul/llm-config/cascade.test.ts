import type { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { CommitActor, GitSyncService, Logger, SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { makeLlmCascadeOnSecretDelete } from "./cascade";

vi.mock("./prune", () => ({
  pruneLlmConfig: vi.fn(() => ({ action: "update", config: { tiers: {} } })),
}));
vi.mock("./soul-yaml-io", () => ({
  writeLlmConfigToSoulYaml: vi.fn(async () => {}),
  deleteLlmConfigFromSoulYaml: vi.fn(async () => {}),
}));

const ACTOR: CommitActor = { principalId: "user:u1", name: "Ada", email: "ada@example.com" };

function deps() {
  const withSync = vi.fn(async () => ({ sha: "abc1234", filesChanged: 1 }));
  const soulLoader = {
    llmConfig: { tiers: {} },
    reload: vi.fn(async () => {}),
  } as unknown as SoulLoader;
  const gitSync = { path: "/soul", withSync } as unknown as GitSyncService;
  const llmService = { init: vi.fn(async () => {}) } as unknown as LlmService;
  const secretsService = {} as unknown as SecretsService;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return { withSync, soulLoader, gitSync, llmService, secretsService, logger };
}

describe("makeLlmCascadeOnSecretDelete", () => {
  it("commits the cascade as the request's actor, not a synthetic default", async () => {
    const d = deps();
    const cascade = makeLlmCascadeOnSecretDelete(
      d.soulLoader,
      d.gitSync,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("anthropic-api-key", ACTOR);

    expect(d.withSync).toHaveBeenCalledWith(expect.stringContaining("anthropic"), ACTOR);
  });
});
