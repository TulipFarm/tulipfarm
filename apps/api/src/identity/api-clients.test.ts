import { describe, expect, it } from "vitest";
import {
  type ApiClientDoc,
  authenticateApiClient,
  createApiClient,
  formatApiClientCredential,
  parseApiClientCredential,
  rotateApiClientSecret,
} from "./api-clients";
import { MemoryApiClientRepo } from "./fakes";
import { assertApiClientAuthenticatable } from "./principal";

describe("api client credentials", () => {
  it("authenticates a freshly minted client", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(repo, { name: "worker", ownerUserId: "u1" });

    const credential = formatApiClientCredential(doc.clientId, secret);
    const authenticated = await authenticateApiClient(repo, credential);

    expect(authenticated?._id).toBe(doc._id);
  });

  it("never persists the secret in plaintext", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(repo, { name: "worker", ownerUserId: "u1" });

    expect(doc.secretHash).not.toContain(secret);
    expect(JSON.stringify(repo.clients)).not.toContain(secret);
  });

  it("denies a wrong secret for a known client id", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc } = await createApiClient(repo, { name: "worker", ownerUserId: "u1" });

    const authenticated = await authenticateApiClient(
      repo,
      formatApiClientCredential(doc.clientId, "not-the-secret")
    );

    expect(authenticated).toBeNull();
  });

  it("denies an unknown client id and a malformed credential the same way", async () => {
    const repo = new MemoryApiClientRepo();

    expect(await authenticateApiClient(repo, formatApiClientCredential("nope", "x"))).toBeNull();
    expect(await authenticateApiClient(repo, "tulip_looks_like_a_user_token")).toBeNull();
    expect(await authenticateApiClient(repo, "tfc_nodot")).toBeNull();
  });

  it("rejects the previous secret after rotation", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(repo, { name: "worker", ownerUserId: "u1" });
    const oldCredential = formatApiClientCredential(doc.clientId, secret);

    const rotated = await rotateApiClientSecret(repo, doc._id);

    expect(await authenticateApiClient(repo, oldCredential)).toBeNull();
    expect((await authenticateApiClient(repo, rotated?.credential ?? ""))?._id).toBe(doc._id);
  });

  it("parses only the tfc_<clientId>.<secret> shape", () => {
    expect(parseApiClientCredential("tfc_abc.def")).toEqual({ clientId: "abc", secret: "def" });
    expect(parseApiClientCredential("tfc_.def")).toBeNull();
    expect(parseApiClientCredential("tfc_abc.")).toBeNull();
    expect(parseApiClientCredential("abc.def")).toBeNull();
  });
});

describe("api client status", () => {
  it("denies a disabled client", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc } = await createApiClient(repo, { name: "worker", ownerUserId: "u1" });
    await repo.updateStatus(doc._id, "disabled");
    const disabled = await repo.findById(doc._id);

    expect(() => assertApiClientAuthenticatable(disabled as ApiClientDoc)).toThrowError(/disabled/);
  });

  it("denies an expired client", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc } = await createApiClient(repo, {
      name: "worker",
      ownerUserId: "u1",
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(() => assertApiClientAuthenticatable(doc)).toThrowError(/expired/);
  });

  it("allows an unexpired active client", async () => {
    const repo = new MemoryApiClientRepo();
    const { doc } = await createApiClient(repo, {
      name: "worker",
      ownerUserId: "u1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(() => assertApiClientAuthenticatable(doc)).not.toThrow();
  });
});
