import type { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { CommitActor, Logger, SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { makeSoulWriterDouble } from "../soul-writer-double";
import { makeLlmCascadeOnSecretDelete } from "./cascade";

// A real config, not a stub: the cascade now hands its result to the soul.yaml merge, which
// validates before the gateway ever sees it.
const PRUNED = {
  tiers: {
    quick: { providers: [{ provider: "azure", model: "gpt-4o" }] },
    standard: { providers: [{ provider: "azure", model: "gpt-4o" }] },
    complex: { providers: [{ provider: "azure", model: "gpt-4o" }] },
  },
};

vi.mock("./prune", () => ({
  pruneLlmConfig: vi.fn(() => ({ action: "update", config: PRUNED })),
}));

const ACTOR: CommitActor = { principalId: "user:u1", name: "Ada", email: "ada@example.com" };

function deps() {
  const soulLoader = {
    llmConfig: { tiers: {} },
    reload: vi.fn(async () => {}),
  } as unknown as SoulLoader;
  const soul = makeSoulWriterDouble();
  const llmService = { init: vi.fn(async () => {}) } as unknown as LlmService;
  const secretsService = {} as unknown as SecretsService;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return { soul, soulLoader, llmService, secretsService, logger };
}

describe("makeLlmCascadeOnSecretDelete", () => {
  it("commits the cascade as the request's actor, not a synthetic default", async () => {
    const d = deps();
    const cascade = makeLlmCascadeOnSecretDelete(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("anthropic-api-key", ACTOR);

    expect(d.soul.applied).toHaveLength(1);
    expect(d.soul.applied[0]?.subject).toContain("anthropic");
    expect(d.soul.applied[0]?.actor).toEqual(ACTOR);
  });

  it("routes the cascade through the write gateway, addressing soul.yaml as an artifact", async () => {
    const d = deps();
    const cascade = makeLlmCascadeOnSecretDelete(
      d.soulLoader,
      d.soul.writer,
      d.llmService,
      d.secretsService,
      d.logger
    );

    await cascade("anthropic-api-key", ACTOR);

    expect(d.soul.applied[0]?.changes).toEqual([
      { op: "put", target: { kind: "Settings" }, content: expect.stringContaining("llm") },
    ]);
  });
});
