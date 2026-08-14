/**
 * Proves direct Soul HTTP writes reach the audit ledger; spies would miss routes that accept but
 * never call AuditService.
 */

import { InMemoryAuditEventRepo } from "@tulipfarm/audit";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { AuditService, SYSTEM_PRINCIPAL_ID } from "./service";
import {
  makeSoulAuditWriter,
  redactRemoteUrl,
  SOUL_DIRECT_WRITE,
  stripUrlCredentials,
} from "./soul-write";

const BUSINESS = "biz-test";

function harness(log: (m: string) => void = () => {}) {
  const repo = new InMemoryAuditEventRepo();
  const svc = new AuditService(repo, BUSINESS, log);
  return { repo, svc, write: makeSoulAuditWriter(svc) };
}

function req(userId?: string): FastifyRequest {
  return { user: userId ? { _id: userId } : undefined } as unknown as FastifyRequest;
}

describe("makeSoulAuditWriter", () => {
  it("records a Soul write attributed to the signed-in user", async () => {
    const { repo, write } = harness();

    await write(req("user-3"), "skill.install", "skill:triage");

    const [event] = await repo.listChain(BUSINESS);
    expect(event?.actor.principalId).toBe("user-3");
    expect(event?.action).toBe("skill.install");
    expect(event?.target).toBe("skill:triage");
  });

  it("tags every event with SOUL_DIRECT_WRITE so the class is queryable", async () => {
    const { repo, write } = harness();

    await write(req("user-3"), "integration.connect", "integration:slack");

    expect((await repo.listChain(BUSINESS))[0]?.reasonCodes).toEqual([SOUL_DIRECT_WRITE]);
  });

  it("attributes an unauthenticated write to the system rather than dropping it", async () => {
    const { repo, write } = harness();

    await write(req(), "soul-config.update", "soul:business-profile");

    expect((await repo.listChain(BUSINESS))[0]?.actor.principalId).toBe(SYSTEM_PRINCIPAL_ID);
  });

  it("carries safe metadata through, and omits the key entirely when there is none", async () => {
    const { repo, write } = harness();

    await write(req("u"), "integration.connect", "integration:slack", { fields: ["botToken"] });
    await write(req("u"), "skill.remove", "skill:triage");

    const chain = await repo.listChain(BUSINESS);
    expect(chain[0]?.safeMetadata).toEqual({ fields: ["botToken"] });
    expect(chain[1]?.safeMetadata).toBeUndefined();
  });

  /**
   * Every call site runs after the file write and git commit have already landed. Throwing here
   * would report failure for work that succeeded, and the event is lost either way.
   */
  it("does not fail the request when the ledger write fails", async () => {
    const warnings: string[] = [];
    const { write } = harness((m) => warnings.push(m));

    // A protected key is rejected by the audit package itself — a real failure, not a stub.
    await expect(
      write(req("u"), "integration.connect", "integration:slack", { token: "shh" })
    ).resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/audit/i);
  });

  /** Audit is optional wiring; a deployment without it must still serve Soul writes. */
  it("is a no-op when no audit service is configured", async () => {
    const write = makeSoulAuditWriter(undefined);

    await expect(write(req("u"), "skill.install", "skill:triage")).resolves.toBeUndefined();
  });
});

/** Free-form clone URLs enter an append-only ledger, so generic masked hosts are redacted. */
describe("redactRemoteUrl", () => {
  it("strips an embedded credential while keeping the repository identity", () => {
    expect(redactRemoteUrl("https://user:s3cret@github.com/acme/soul.git")).toBe(
      "https://github.com/acme/soul.git"
    );
    expect(redactRemoteUrl("https://ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.com/acme/soul")).toBe(
      "https://github.com/acme/soul"
    );
  });

  it("keeps a plain URL usable as provenance", () => {
    expect(redactRemoteUrl("https://github.com/acme/soul.git")).toBe(
      "https://github.com/acme/soul.git"
    );
  });

  it("keeps scp-style remotes, dropping the user part as the URL branch does", () => {
    expect(redactRemoteUrl("git@github.com:acme/soul.git")).toBe("github.com:acme/soul.git");
    expect(redactRemoteUrl("github.com:acme/soul.git")).toBe("github.com:acme/soul.git");
  });

  /**
   * Reject control characters: WHATWG URL parsing deletes them and can hide secrets in the path.
   */
  it("refuses input with control characters, which the URL parser folds into the path", () => {
    for (const smuggled of [
      "https://h/r\nAUTH: s3cret",
      "https://h/r\ts3cret",
      "https://h/r\rs3cret",
    ]) {
      expect(redactRemoteUrl(smuggled)).toBe("unparsed");
    }
  });

  /** Keep owner/repo sources; collapsing them destroys audit provenance. */
  it("keeps credential-free shorthand, the commonest source form", () => {
    expect(redactRemoteUrl("acme/skills")).toBe("acme/skills");
    expect(redactRemoteUrl("acme/skills#main")).toBe("acme/skills#main");
    expect(redactRemoteUrl("builtin")).toBe("builtin");
    expect(redactRemoteUrl("github.com/acme/x")).toBe("github.com/acme/x");
  });

  /** The shorthand branch is an allowance, not a hole: it takes locators, not arbitrary strings. */
  it("does not let the shorthand branch pass traversal or junk through", () => {
    expect(redactRemoteUrl("../../etc/passwd")).toBe("unparsed");
    expect(redactRemoteUrl("a/b/c/d/e/f")).toBe("unparsed");
    expect(redactRemoteUrl("user:tok@github.com/a")).toBe("unparsed");
    expect(redactRemoteUrl("x".repeat(600))).toBe("unparsed");
  });

  /** Not remotes. Recording them discloses local paths and gains nothing. */
  it("refuses non-transport schemes", () => {
    expect(redactRemoteUrl("file:///etc/passwd")).toBe("unparsed");
    expect(redactRemoteUrl("data:text/plain,s3cret")).toBe("unparsed");
    expect(redactRemoteUrl("javascript:alert('s3cret')")).toBe("unparsed");
  });

  it("redacts every credential position at once", () => {
    expect(redactRemoteUrl("https://u:s3cret@h/r?t=s3cret#s3cret")).toBe("https://h/r");
    expect(redactRemoteUrl("ssh://git:s3cret@host/repo.git")).toBe("ssh://host/repo.git");
    expect(redactRemoteUrl("https://a@b:s3cret@github.com/r")).toBe("https://github.com/r");
  });

  it("drops a query string, which is where a token is smuggled when userinfo is not", () => {
    expect(redactRemoteUrl("https://host/repo?access_token=s3cret")).toBe("https://host/repo");
  });

  it("refuses to echo back something it could not parse", () => {
    expect(redactRemoteUrl("not a url with s3cret in it")).toBe("unparsed");
  });

  it("never lets a credential survive into recorded metadata", async () => {
    const { repo, write } = harness();

    await write(req("u"), "soul-config.git-remote", "soul:git-remote", {
      remote: redactRemoteUrl("https://user:hunter2@example.com/acme/soul.git"),
    });

    expect(JSON.stringify(await repo.listChain(BUSINESS))).not.toContain("hunter2");
  });
});

/**
 * Redact credential-bearing clone URLs in skills-lock.json without changing file:// or owner/repo
 * provenance.
 */
describe("stripUrlCredentials", () => {
  it("removes an embedded credential", () => {
    expect(stripUrlCredentials("https://user:ghp_tok@github.com/acme/x.git")).toBe(
      "https://github.com/acme/x.git"
    );
    expect(stripUrlCredentials("https://ghp_tok@github.com/acme/x")).toBe(
      "https://github.com/acme/x"
    );
  });

  /**
   * Match greedily to the last @ before the first / so credentials containing @ are fully redacted.
   */
  it("removes the whole userinfo when it contains another @", () => {
    expect(stripUrlCredentials("https://a@b:ghp_tok@github.com/r")).toBe("https://github.com/r");
  });

  it("leaves credential-free sources byte-identical", () => {
    for (const source of [
      "https://github.com/acme/x.git",
      "file:///tmp/skill-remote-abc",
      "acme/skills",
      "acme/skills#main",
      "builtin",
      "git@github.com:acme/x.git",
      "",
    ]) {
      expect(stripUrlCredentials(source)).toBe(source);
    }
  });
});
