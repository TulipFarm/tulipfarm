import { describe, expect, it, vi } from "vitest";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDef } from "../tools/types";
import { IngressIdentityResolver } from "./identity";

const alice: UserDoc = {
  _id: "u1",
  email: "alice@example.com",
  passwordHash: "",
  role: "member",
  status: "active" as const,
  createdAt: new Date(),
};
const admin: UserDoc = {
  _id: "u0",
  email: "admin@example.com",
  passwordHash: "",
  role: "admin",
  status: "active" as const,
  createdAt: new Date(),
};

const IDENTITY = {
  tool: "get_user_profile",
  args: { user_id: "{sender}" },
  email_path: "profile.email",
};

function makeUsers(overrides: Partial<IngressUserLookup> = {}): IngressUserLookup {
  return {
    findByEmail: async (email: string) => (email === alice.email ? alice : null),
    findById: async () => null,
    findFirstAdmin: async () => admin,
    ...overrides,
  };
}

function makeRegistry(execute: ToolDef["execute"]): ToolRegistry {
  return {
    getAll: () => [
      { name: "integration_chatapp_get_user_profile", tier: "integration", execute } as ToolDef,
    ],
  } as unknown as ToolRegistry;
}

function makeLog() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
}

describe("IngressIdentityResolver", () => {
  it("resolves via the identity binding: tool call → email_path → user match", async () => {
    const execute = vi.fn(async (_args: unknown) => ({
      success: true as const,
      data: {
        content: [
          { type: "text", text: JSON.stringify({ profile: { email: "alice@example.com" } }) },
        ],
      },
    }));
    const resolver = new IngressIdentityResolver(makeUsers(), makeLog());
    const user = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT1",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    });
    expect(user).toEqual(alice);
    expect(execute).toHaveBeenCalledWith({ user_id: "EXT1" }, expect.anything());
  });

  it("denies when the verified external email matches no user", async () => {
    const execute = async () => ({
      success: true as const,
      data: { structuredContent: { profile: { email: "stranger@example.com" } } },
    });
    const resolver = new IngressIdentityResolver(makeUsers(), makeLog());
    const user = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT2",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    });
    expect(user).toBeNull();
  });

  it("denies when the identity binding tool fails", async () => {
    const execute = async () => ({
      success: false as const,
      error: { code: "internal_error" as const, message: "boom" },
    });
    const log = makeLog();
    const resolver = new IngressIdentityResolver(makeUsers(), log);
    const user = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT3",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    });
    expect(user).toBeNull();
    expect((log as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it("denies when no identity binding is declared", async () => {
    const resolver = new IngressIdentityResolver(makeUsers(), makeLog());
    const user = await resolver.resolve({ slug: "chatapp", sender: "EXT4" });
    expect(user).toBeNull();
  });

  it("caches resolutions per slug+sender (one tool call for repeat senders)", async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: { structuredContent: { profile: { email: "alice@example.com" } } },
    }));
    const resolver = new IngressIdentityResolver(makeUsers(), makeLog());
    const opts = {
      slug: "chatapp",
      sender: "EXT1",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    };
    await resolver.resolve(opts);
    await resolver.resolve(opts);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not consult an admin fallback when no mapping can be established", async () => {
    const findFirstAdmin = vi.fn(async () => admin);
    const resolver = new IngressIdentityResolver(makeUsers({ findFirstAdmin }), makeLog());
    const user = await resolver.resolve({ slug: "chatapp", sender: "EXT9" });
    expect(user).toBeNull();
    expect(findFirstAdmin).not.toHaveBeenCalled();
  });
});
