import { describe, expect, it, vi } from "vitest";
import { knowledgeManifestFixture } from "./oim-manifest.fixture";
import {
  type KnowledgeIdentityPolicy,
  mapAclEntries,
  mapContent,
  mapListItems,
  type ProviderAccountPort,
  type ProviderAclEntry,
  type ProviderIdentityLinkPort,
  resolveKnowledgePrincipals,
  type VerifiedEmailPrincipalPort,
} from "./oim-mapping";
import { compileKnowledgeProfile } from "./oim-profile";

const plan = compileKnowledgeProfile(knowledgeManifestFixture());

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: "42",
    version: { number: 7, when: "2026-01-01T00:00:00.000Z" },
    title: "Runbook",
    _links: { webui: "/pages/42" },
    archived: false,
    ...overrides,
  };
}

describe("mapListItems", () => {
  it("reads the declared fields off each item", () => {
    expect(mapListItems(plan, { results: [page()] })).toEqual([
      {
        itemId: "42",
        revision: "7",
        title: "Runbook",
        sourceUrl: "/pages/42",
        updatedAt: "2026-01-01T00:00:00.000Z",
        contentType: undefined,
        deleted: false,
      },
    ]);
  });

  it("skips an item with no stable id rather than inventing one", () => {
    expect(mapListItems(plan, { results: [page({ id: undefined }), page({ id: "9" })] })).toEqual([
      expect.objectContaining({ itemId: "9" }),
    ]);
  });

  it("returns nothing when the items pointer resolves to something that is not a list", () => {
    expect(mapListItems(plan, { results: { id: "42" } })).toEqual([]);
    expect(mapListItems(plan, {})).toEqual([]);
  });

  // A provider that answers "false" is saying the page is present; reading that as truthy would
  // delete live content out of the index on the very next sync.
  it("treats only an unambiguous flag as a deletion", () => {
    const flags: [unknown, boolean][] = [
      [true, true],
      ["true", true],
      [1, true],
      [false, false],
      ["false", false],
      [0, false],
      ["", false],
      [null, false],
    ];
    for (const [value, expected] of flags) {
      expect(mapListItems(plan, { results: [page({ archived: value })] })[0]?.deleted).toBe(
        expected
      );
    }
  });

  it("reads a numeric provider id as text so a revision comparison is stable", () => {
    expect(mapListItems(plan, { results: [page({ id: 42 })] })[0]?.itemId).toBe("42");
  });

  it("cannot be walked into the prototype chain by a provider-controlled pointer", () => {
    const hostile = compileKnowledgeProfile(
      knowledgeManifestFixture({
        list: {
          ...knowledgeManifestFixture().knowledge?.list,
          mapping: { itemId: "/constructor" },
        },
      })
    );
    expect(mapListItems(hostile, { results: [page()] })).toEqual([]);
  });
});

describe("mapContent", () => {
  it("reads the body and the fields declared beside it", () => {
    expect(
      mapContent(plan, {
        body: { storage: { value: "hello" } },
        version: { number: 3 },
        title: "T",
      })
    ).toEqual({
      content: "hello",
      contentType: undefined,
      revision: "3",
      title: "T",
      sourceUrl: undefined,
      updatedAt: undefined,
    });
  });

  it("distinguishes an absent body from an empty one", () => {
    expect(mapContent(plan, {})).toBeUndefined();
    expect(mapContent(plan, { body: { storage: { value: "" } } })?.content).toBe("");
  });
});

describe("mapAclEntries", () => {
  it("reads users, groups and public grants the manifest can interpret", () => {
    const result = mapAclEntries(plan, {
      results: [
        { type: "known", accountId: "u1" },
        { type: "group", groupId: "g1" },
        { type: "anonymous" },
      ],
    });
    expect(result).toEqual({
      status: "verified",
      entries: [{ kind: "user", id: "u1" }, { kind: "group", id: "g1" }, { kind: "public" }],
    });
  });

  it("fails closed when the ACL response has no entries pointer at all", () => {
    expect(mapAclEntries(plan, {})).toEqual({ status: "unverifiable", reason: "entries_absent" });
  });

  it("fails closed when the entries pointer is not a list", () => {
    expect(mapAclEntries(plan, { results: "everyone" })).toEqual({
      status: "unverifiable",
      reason: "entries_not_array",
    });
  });

  // Providers use "no restrictions" to mean "inherits from the container", so reading an empty
  // list as unrestricted is how an index publishes a private document.
  it("fails closed on an empty entry list rather than reading it as unrestricted", () => {
    expect(mapAclEntries(plan, { results: [] })).toEqual({
      status: "unverifiable",
      reason: "no_entries",
    });
  });

  it("fails the whole ACL when one entry names a kind the manifest never declared", () => {
    expect(
      mapAclEntries(plan, {
        results: [
          { type: "known", accountId: "u1" },
          { type: "service_account", id: "s1" },
        ],
      })
    ).toEqual({ status: "unverifiable", reason: "entry_kind_unknown" });
  });

  it("fails the whole ACL when an entry carries no identifier", () => {
    expect(mapAclEntries(plan, { results: [{ type: "known" }] })).toEqual({
      status: "unverifiable",
      reason: "entry_identifier_absent",
    });
  });

  it("falls back to the declared default kind when the provider says nothing about kind", () => {
    const flat = compileKnowledgeProfile(
      knowledgeManifestFixture({
        acl: {
          ...knowledgeManifestFixture().knowledge?.acl,
          entry: { defaultKind: "user", providerUserId: "/accountId" },
        },
      })
    );
    expect(mapAclEntries(flat, { results: [{ accountId: "u1" }] })).toEqual({
      status: "verified",
      entries: [{ kind: "user", id: "u1" }],
    });
  });
});

function identityDeps(overrides: Partial<Parameters<typeof resolveKnowledgePrincipals>[1]> = {}) {
  const links: ProviderIdentityLinkPort = {
    linkedPrincipal: vi.fn(async (input: { providerId: string }) =>
      input.providerId === "u1" ? { kind: "user", id: "muskan" } : undefined
    ),
  };
  const policy: KnowledgeIdentityPolicy = { verifiedEmailDomains: [] };
  return { businessId: "b1", provider: "wiki", links, policy, ...overrides };
}

describe("resolveKnowledgePrincipals", () => {
  it("resolves a provider account through its stable link", async () => {
    const result = await resolveKnowledgePrincipals([{ kind: "user", id: "u1" }], identityDeps());
    expect(result.principals).toEqual([{ kind: "user", id: "muskan" }]);
    expect(result.incomplete).toBe(false);
  });

  // Dropping narrows access, so an unlinked account is safe to skip. Granting one would not be.
  it("drops an account nothing links, rather than granting it", async () => {
    const result = await resolveKnowledgePrincipals(
      [{ kind: "user", id: "stranger" }],
      identityDeps()
    );
    expect(result.principals).toEqual([]);
  });

  it("never matches by email while no domain is enabled, even for a verified address", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => ({ email: "muskan@example.com", emailVerified: true })),
      groupMembers: vi.fn(async () => undefined),
    };
    const emails: VerifiedEmailPrincipalPort = {
      principalForEmail: vi.fn(async () => ({ kind: "user", id: "muskan" })),
    };
    const result = await resolveKnowledgePrincipals(
      [{ kind: "user", id: "stranger" }],
      identityDeps({ accounts, emails })
    );
    expect(result.principals).toEqual([]);
    expect(emails.principalForEmail).not.toHaveBeenCalled();
  });

  it("matches a verified address on an enabled domain", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => ({ email: "Muskan@Example.com", emailVerified: true })),
      groupMembers: vi.fn(async () => undefined),
    };
    const emails: VerifiedEmailPrincipalPort = {
      principalForEmail: vi.fn(async () => ({ kind: "user", id: "muskan" })),
    };
    const result = await resolveKnowledgePrincipals(
      [{ kind: "user", id: "stranger" }],
      identityDeps({ accounts, emails, policy: { verifiedEmailDomains: ["example.com"] } })
    );
    expect(result.principals).toEqual([{ kind: "user", id: "muskan" }]);
    expect(emails.principalForEmail).toHaveBeenCalledWith({
      businessId: "b1",
      email: "muskan@example.com",
    });
  });

  it("refuses an unverified address even on an enabled domain", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => ({ email: "muskan@example.com", emailVerified: false })),
      groupMembers: vi.fn(async () => undefined),
    };
    const emails: VerifiedEmailPrincipalPort = {
      principalForEmail: vi.fn(async () => ({ kind: "user", id: "muskan" })),
    };
    const result = await resolveKnowledgePrincipals(
      [{ kind: "user", id: "stranger" }],
      identityDeps({ accounts, emails, policy: { verifiedEmailDomains: ["example.com"] } })
    );
    expect(result.principals).toEqual([]);
  });

  it("refuses a verified address on a domain nobody enabled", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => ({ email: "muskan@other.example", emailVerified: true })),
      groupMembers: vi.fn(async () => undefined),
    };
    const emails: VerifiedEmailPrincipalPort = {
      principalForEmail: vi.fn(async () => ({ kind: "user", id: "muskan" })),
    };
    const result = await resolveKnowledgePrincipals(
      [{ kind: "user", id: "stranger" }],
      identityDeps({ accounts, emails, policy: { verifiedEmailDomains: ["example.com"] } })
    );
    expect(result.principals).toEqual([]);
  });

  it("expands a group into its members", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => undefined),
      groupMembers: vi.fn(async () => ["u1", "stranger"]),
    };
    const result = await resolveKnowledgePrincipals(
      [{ kind: "group", id: "g1" }],
      identityDeps({ accounts })
    );
    expect(result.principals).toEqual([{ kind: "user", id: "muskan" }]);
    expect(result.incomplete).toBe(false);
  });

  it("reports the ACL incomplete when a group membership is unreadable", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => undefined),
      groupMembers: vi.fn(async () => undefined),
    };
    const result = await resolveKnowledgePrincipals(
      [{ kind: "group", id: "g1" }],
      identityDeps({ accounts })
    );
    expect(result.incomplete).toBe(true);
  });

  it("reports a group grant incomplete when nothing can expand groups at all", async () => {
    const result = await resolveKnowledgePrincipals([{ kind: "group", id: "g1" }], identityDeps());
    expect(result.incomplete).toBe(true);
  });

  it("does not repeat a principal reached through two grants", async () => {
    const accounts: ProviderAccountPort = {
      account: vi.fn(async () => undefined),
      groupMembers: vi.fn(async () => ["u1"]),
    };
    const entries: ProviderAclEntry[] = [
      { kind: "user", id: "u1" },
      { kind: "group", id: "g1" },
    ];
    const result = await resolveKnowledgePrincipals(entries, identityDeps({ accounts }));
    expect(result.principals).toEqual([{ kind: "user", id: "muskan" }]);
  });

  it("collects domain and public grants separately from principals", async () => {
    const result = await resolveKnowledgePrincipals(
      [{ kind: "domain", id: "Example.com" }, { kind: "public" }],
      identityDeps()
    );
    expect(result.domains).toEqual(["example.com"]);
    expect(result.public).toBe(true);
  });
});
