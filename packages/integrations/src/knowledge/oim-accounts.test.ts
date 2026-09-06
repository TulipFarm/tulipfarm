import { describe, expect, it } from "vitest";
import { createOimProviderAccountPort } from "./oim-accounts";
import { knowledgeManifestFixture } from "./oim-manifest.fixture";
import { compileKnowledgeProfile } from "./oim-profile";
import type { OimKnowledgeApiPort } from "./oim-sync";

function api(
  handler: (input: {
    readonly operationId: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly pageToken?: string;
  }) => { readonly body: unknown; readonly nextPageToken?: string }
): OimKnowledgeApiPort {
  return { execute: async (input) => handler(input) };
}

const plan = compileKnowledgeProfile(knowledgeManifestFixture());

describe("createOimProviderAccountPort", () => {
  it("reads an account's email and verification flag", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => ({ body: { email: "muskan@example.com", emailVerified: true } }))
    );
    expect(await port.account({ providerId: "u1" })).toEqual({
      email: "muskan@example.com",
      emailVerified: true,
    });
  });

  it("passes the provider id through the declared parameter", async () => {
    const seen: Record<string, unknown>[] = [];
    const port = createOimProviderAccountPort(
      plan,
      api((input) => {
        seen.push({ ...input.parameters, operationId: input.operationId });
        return { body: {} };
      })
    );
    await port.account({ providerId: "u9" });
    expect(seen).toEqual([{ accountId: "u9", operationId: "get-user" }]);
  });

  it("treats any non-true verification value as unverified", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => ({ body: { email: "m@example.com", emailVerified: "true" } }))
    );
    expect(await port.account({ providerId: "u1" })).toEqual({
      email: "m@example.com",
      emailVerified: false,
    });
  });

  it("returns undefined when the account read fails", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => {
        throw new Error("refused");
      })
    );
    expect(await port.account({ providerId: "u1" })).toBeUndefined();
  });

  it("returns no email when the pointer reads nothing", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => ({ body: {} }))
    );
    expect(await port.account({ providerId: "u1" })).toEqual({});
  });

  it("expands a group's membership", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => ({ body: { members: [{ accountId: "u1" }, { accountId: "u2" }] } }))
    );
    expect(await port.groupMembers({ groupId: "g1" })).toEqual(["u1", "u2"]);
  });

  it("follows pagination across membership pages", async () => {
    let call = 0;
    const port = createOimProviderAccountPort(
      plan,
      api(() => {
        call += 1;
        return call === 1
          ? { body: { members: [{ accountId: "u1" }] }, nextPageToken: "p2" }
          : { body: { members: [{ accountId: "u2" }] } };
      })
    );
    expect(await port.groupMembers({ groupId: "g1" })).toEqual(["u1", "u2"]);
  });

  it("returns undefined when a membership page fails mid-walk", async () => {
    let call = 0;
    const port = createOimProviderAccountPort(
      plan,
      api(() => {
        call += 1;
        if (call === 2) throw new Error("refused");
        return { body: { members: [{ accountId: "u1" }] }, nextPageToken: "p2" };
      })
    );
    expect(await port.groupMembers({ groupId: "g1" })).toBeUndefined();
  });

  it("returns undefined when the members pointer is not a list", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => ({ body: { members: "u1" } }))
    );
    expect(await port.groupMembers({ groupId: "g1" })).toBeUndefined();
  });

  it("returns undefined when the manifest declares no group lookup", async () => {
    const manifest = knowledgeManifestFixture({
      identity: {
        user: {
          operationId: "get-user",
          idParameter: "accountId",
          mapping: { providerId: "/accountId", email: "/email", emailVerified: "/emailVerified" },
        },
      },
    });
    const port = createOimProviderAccountPort(
      compileKnowledgeProfile(manifest),
      api(() => ({ body: {} }))
    );
    expect(await port.groupMembers({ groupId: "g1" })).toBeUndefined();
  });

  it("stops rather than returning a partial membership beyond the page bound", async () => {
    const port = createOimProviderAccountPort(
      plan,
      api(() => ({ body: { members: [{ accountId: "u1" }] }, nextPageToken: "more" }))
    );
    expect(await port.groupMembers({ groupId: "g1" })).toBeUndefined();
  });
});
