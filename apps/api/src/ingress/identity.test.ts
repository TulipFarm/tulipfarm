import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import { SlackIdentityResolver } from "./identity";
import { SlackApiError, type SlackClient } from "./slack-client";

function makeUser(email: string, role: "admin" | "member" = "member"): UserDoc {
  return { _id: randomUUID(), email, passwordHash: "x", role, createdAt: new Date() };
}

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

function makeClient(emailByUser: Record<string, string | null>) {
  const userEmail = vi.fn(async (id: string) => {
    const email = emailByUser[id];
    if (email === undefined) throw new SlackApiError("users.info", "user_not_found");
    return email;
  });
  return { client: { userEmail } as unknown as SlackClient, userEmail };
}

function makeUsers(docs: UserDoc[], admin: UserDoc | null) {
  const lookup: IngressUserLookup = {
    findByEmail: vi.fn(async (email: string) => docs.find((d) => d.email === email) ?? null),
    findById: vi.fn(async (id: string) => docs.find((d) => d._id === id) ?? null),
    findFirstAdmin: vi.fn(async () => admin),
  };
  return lookup;
}

describe("SlackIdentityResolver", () => {
  it("maps a sender to the TulipFarm user with a matching email", async () => {
    const mohit = makeUser("mohit@example.com");
    const admin = makeUser("admin@example.com", "admin");
    const users = makeUsers([mohit, admin], admin);
    const { client } = makeClient({ U1: "mohit@example.com" });
    const resolver = new SlackIdentityResolver(users, log);
    const resolved = await resolver.resolve(client, "U1");
    expect(resolved?._id).toBe(mohit._id);
  });

  it("falls back to the first admin when no email matches", async () => {
    const admin = makeUser("admin@example.com", "admin");
    const users = makeUsers([admin], admin);
    const { client } = makeClient({ U2: "stranger@example.com" });
    const resolver = new SlackIdentityResolver(users, log);
    const resolved = await resolver.resolve(client, "U2");
    expect(resolved?._id).toBe(admin._id);
  });

  it("falls back to admin when Slack withholds the email or errors", async () => {
    const admin = makeUser("admin@example.com", "admin");
    const users = makeUsers([admin], admin);
    const { client } = makeClient({ U3: null }); // no email
    const resolver = new SlackIdentityResolver(users, log);
    expect((await resolver.resolve(client, "U3"))?._id).toBe(admin._id);
    expect((await resolver.resolve(client, "UNKNOWN"))?._id).toBe(admin._id); // API error path
  });

  it("caches resolutions per sender (users.info called once)", async () => {
    const mohit = makeUser("mohit@example.com");
    const admin = makeUser("admin@example.com", "admin");
    const users = makeUsers([mohit, admin], admin);
    const { client, userEmail } = makeClient({ U1: "mohit@example.com" });
    const resolver = new SlackIdentityResolver(users, log);
    await resolver.resolve(client, "U1");
    await resolver.resolve(client, "U1");
    expect(userEmail).toHaveBeenCalledTimes(1);
  });

  it("returns null when no admin exists (post-bootstrap this cannot happen)", async () => {
    const users = makeUsers([], null);
    const { client } = makeClient({ U9: null });
    const resolver = new SlackIdentityResolver(users, log);
    expect(await resolver.resolve(client, "U9")).toBeNull();
  });
});
