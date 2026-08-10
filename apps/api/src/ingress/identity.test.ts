import { describe, expect, it, vi } from "vitest";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ChannelBindDeps } from "../identity/channel-link";
import { MemoryExternalIdentityRepo } from "../identity/fakes";
import { declarativeToolName } from "../tools/declarative/tools";
import type { ToolDef } from "../tools/types";
import { IngressIdentityResolver } from "./identity";

const alice: UserDoc = {
  _id: "u1",
  email: "alice@example.com",
  passwordHash: "",
  name: null,
  role: "member",
  status: "active" as const,
  createdAt: new Date(),
};
const admin: UserDoc = {
  _id: "u0",
  email: "admin@example.com",
  passwordHash: "",
  name: null,
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
    findById: async (id: string) => [alice, admin].find((user) => user._id === id) ?? null,
    findFirstAdmin: async () => admin,
    ...overrides,
  };
}

function makeRegistry(execute: ToolDef["execute"]): ToolRegistry {
  return {
    getAll: () => [
      {
        name: declarativeToolName("chatapp", "get_user_profile"),
        tier: "integration",
        execute,
      } as ToolDef,
    ],
  } as unknown as ToolRegistry;
}

function makeLog() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
}

function bindDeps(repo: MemoryExternalIdentityRepo): ChannelBindDeps {
  return { repo, signingKey: async () => Buffer.alloc(32, 7) };
}

function harness(
  over: {
    users?: Partial<IngressUserLookup>;
    mappings?: MemoryExternalIdentityRepo;
    bind?: boolean;
  } = {}
) {
  const mappings = over.mappings ?? new MemoryExternalIdentityRepo();
  const log = makeLog();
  const resolver = new IngressIdentityResolver({
    users: makeUsers(over.users),
    log,
    mappings,
    ...(over.bind === false ? {} : { bind: bindDeps(mappings) }),
  });
  return { resolver, mappings, log: log as unknown as { warn: ReturnType<typeof vi.fn> } };
}

const profileTool = (email: string) =>
  vi.fn(async (_args: unknown) => ({
    success: true as const,
    data: { content: [{ type: "text", text: JSON.stringify({ profile: { email } }) }] },
  }));

describe("IngressIdentityResolver", () => {
  it("honours an existing mapping without re-deriving identity from the channel", async () => {
    // The manifest binding is the *slow* path. Once a sender is verified, asking the integration
    // again on every message would make our authority a copy of theirs.
    const { resolver, mappings } = harness();
    await mappings.upsertMapping({
      provider: "chatapp",
      externalSubject: "EXT1",
      userId: alice._id,
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "bind_link",
    });
    const execute = profileTool("alice@example.com");

    const result = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT1",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    });

    expect(result).toEqual({ outcome: "linked", user: alice });
    expect(execute).not.toHaveBeenCalled();
  });

  it("auto-links through the manifest binding and persists the mapping it derived", async () => {
    // Persisting is what makes the link survive a restart — and what makes it auditable.
    const { resolver, mappings } = harness();
    const execute = profileTool("alice@example.com");

    const result = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT1",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    });

    expect(result).toMatchObject({ outcome: "linked", user: alice });
    expect(execute).toHaveBeenCalledWith({ user_id: "EXT1" }, expect.anything());
    expect(await mappings.findMapping("chatapp", "EXT1")).toMatchObject({
      userId: alice._id,
      verifiedVia: "manifest_email",
    });
  });

  it("asks the integration once, because the second message reads the row the first wrote", async () => {
    const { resolver } = harness();
    const execute = profileTool("alice@example.com");
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

  it("refuses a sender whose verified email matches no account, and offers a bind link", async () => {
    const { resolver, mappings } = harness();

    const result = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT2",
      identity: IDENTITY,
      registry: makeRegistry(profileTool("stranger@example.com")),
    });

    expect(result.outcome).toBe("unlinked");
    expect(result).toMatchObject({ bindOffer: { token: expect.any(String) } });
    // Nothing was written: an offer is not a link.
    expect(await mappings.findMapping("chatapp", "EXT2")).toBeNull();
  });

  it("refuses when the identity binding fails, rather than guessing who the sender is", async () => {
    const { resolver, log } = harness();
    const execute = async () => ({
      success: false as const,
      error: { code: "internal_error" as const, message: "boom" },
    });

    const result = await resolver.resolve({
      slug: "chatapp",
      sender: "EXT3",
      identity: IDENTITY,
      registry: makeRegistry(execute),
    });

    expect(result.outcome).toBe("unlinked");
    expect(log.warn).toHaveBeenCalled();
  });

  it("refuses when no identity binding is declared at all", async () => {
    const { resolver } = harness();

    const result = await resolver.resolve({ slug: "chatapp", sender: "EXT4" });

    expect(result.outcome).toBe("unlinked");
  });

  it("never falls back to an administrator for a sender it cannot place", async () => {
    // The one substitution that would turn an unknown stranger into full authority.
    const findFirstAdmin = vi.fn(async () => admin);
    const { resolver } = harness({ users: { findFirstAdmin } });

    const result = await resolver.resolve({ slug: "chatapp", sender: "EXT9" });

    expect(result.outcome).toBe("unlinked");
    expect(findFirstAdmin).not.toHaveBeenCalled();
  });

  it("stops honouring a mapping once the account may no longer act", async () => {
    // Suspending someone has to close the channel door too, or it closes nothing.
    const { resolver, mappings } = harness({
      users: { findById: async () => ({ ...alice, status: "disabled" as const }) },
    });
    await mappings.upsertMapping({
      provider: "chatapp",
      externalSubject: "EXT1",
      userId: alice._id,
      verifiedAt: new Date(),
      expiresAt: null,
      verifiedVia: "bind_link",
    });

    const result = await resolver.resolve({ slug: "chatapp", sender: "EXT1" });

    expect(result.outcome).toBe("unlinked");
  });

  it("still refuses when no bind flow is configured, offering nothing", async () => {
    const { resolver } = harness({ bind: false });

    const result = await resolver.resolve({ slug: "chatapp", sender: "EXT4" });

    expect(result).toEqual({ outcome: "unlinked", bindOffer: null });
  });
});
