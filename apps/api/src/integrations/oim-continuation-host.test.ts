import { randomBytes } from "node:crypto";
import type { OimContinuationState } from "@tulipfarm/integrations";
import type { ActiveDek } from "@tulipfarm/secrets";
import { describe, expect, it } from "vitest";
import { createOimPaginationRuntime } from "./oim-continuation-host";

const NOW = 1_735_689_600_000;
const CONTEXT = {
  toolId: "github.list_issues",
  scope: "compiled-operation-and-caller",
  pagination: {
    type: "cursor" as const,
    responsePointer: "/next_cursor",
    requestParameter: "cursor",
  },
  baseUrl: "https://api.github.com",
};

function dek(): Pick<ActiveDek, "key"> {
  return { key: randomBytes(32) };
}

function state(cursor = "provider-secret-cursor"): OimContinuationState {
  return {
    version: 3,
    toolId: CONTEXT.toolId,
    scope: CONTEXT.scope,
    style: CONTEXT.pagination.type,
    cursor,
    progress: {
      pages: 1,
      items: 10,
      bytes: 512,
      startedAtMs: NOW - 1_000,
    },
  };
}

describe("OIM continuation host", () => {
  it("opens a confidential token after restart on a replica with the same configured key", async () => {
    const activeDek = dek();
    const firstProcess = createOimPaginationRuntime({
      dek: activeDek,
      now: () => NOW,
    });
    const restartedReplica = createOimPaginationRuntime({
      dek: activeDek,
      now: () => NOW,
    });

    const token = await firstProcess.codec.seal(state());

    expect(token).not.toContain("provider-secret-cursor");
    expect(Buffer.from(token.slice("oim1.".length), "base64url").toString("utf8")).not.toContain(
      "provider-secret-cursor"
    );
    await expect(
      restartedReplica.codec.unseal(token, {
        toolId: CONTEXT.toolId,
        scope: CONTEXT.scope,
        style: CONTEXT.pagination.type,
      })
    ).resolves.toEqual(state());
  });

  it.each([
    {
      name: "Tool",
      expected: {
        toolId: "github.list_pull_requests",
        scope: CONTEXT.scope,
        style: CONTEXT.pagination.type,
      },
    },
    {
      name: "scope",
      expected: {
        toolId: CONTEXT.toolId,
        scope: "another-caller-or-configuration",
        style: CONTEXT.pagination.type,
      },
    },
    {
      name: "pagination style",
      expected: {
        toolId: CONTEXT.toolId,
        scope: CONTEXT.scope,
        style: "page" as const,
      },
    },
  ])("rejects a token outside its exact $name binding", async ({ expected }) => {
    const runtime = createOimPaginationRuntime({ dek: dek(), now: () => NOW });
    const token = await runtime.codec.seal(state());

    await expect(runtime.codec.unseal(token, expected)).rejects.toThrow(
      "invalid continuation token"
    );
  });

  it("rejects an expired token before returning provider state", async () => {
    const runtime = createOimPaginationRuntime({ dek: dek(), now: () => NOW });
    const token = await runtime.codec.seal({
      ...state(),
      progress: { ...state().progress, startedAtMs: NOW - 60_000 },
    });

    await expect(
      runtime.codec.unseal(token, {
        toolId: CONTEXT.toolId,
        scope: CONTEXT.scope,
        style: CONTEXT.pagination.type,
      })
    ).rejects.toThrow();
  });

  it("refuses continuation state that cannot fit the public token bound", async () => {
    const runtime = createOimPaginationRuntime({ dek: dek(), now: () => NOW });

    await expect(runtime.codec.seal(state("x".repeat(4_096)))).rejects.toThrow(
      "continuation token is too large"
    );
  });

  it("rejects a token whose encoded bytes were tampered with", async () => {
    const runtime = createOimPaginationRuntime({ dek: dek(), now: () => NOW });
    const token = await runtime.codec.seal(state());

    await expect(
      runtime.codec.unseal(`${token}!`, {
        toolId: CONTEXT.toolId,
        scope: CONTEXT.scope,
        style: CONTEXT.pagination.type,
      })
    ).rejects.toThrow();
  });

  it("rejects authenticated ciphertext changed or opened with another deployment key", async () => {
    const runtime = createOimPaginationRuntime({ dek: dek(), now: () => NOW });
    const token = await runtime.codec.seal(state());
    const finalCharacter = token.at(-1);
    const tampered = `${token.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
    const anotherDeployment = createOimPaginationRuntime({ dek: dek(), now: () => NOW });
    const expected = {
      toolId: CONTEXT.toolId,
      scope: CONTEXT.scope,
      style: CONTEXT.pagination.type,
    };

    await expect(runtime.codec.unseal(tampered, expected)).rejects.toThrow();
    await expect(anotherDeployment.codec.unseal(token, expected)).rejects.toThrow();
  });
});
