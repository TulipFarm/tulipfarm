import { describe, expect, it } from "vitest";
import { buildToolPreview } from "./tool-preview";

function parse(json: string): unknown {
  return JSON.parse(json);
}

describe("buildToolPreview", () => {
  it("omits a preview for a value that carries nothing to show", () => {
    expect(buildToolPreview(null)).toBeUndefined();
    expect(buildToolPreview(undefined)).toBeUndefined();
  });

  it("keeps ordinary arguments readable", () => {
    const preview = buildToolPreview({ repo: "maddhruv/tulipfarm", issue: 412, dryRun: false });

    expect(preview).toBeDefined();
    expect(parse(preview?.json ?? "")).toEqual({
      repo: "maddhruv/tulipfarm",
      issue: 412,
      dryRun: false,
    });
    expect(preview?.redactedPaths).toBeUndefined();
    expect(preview?.truncated).toBeUndefined();
  });

  it("redacts by key name across casing and separator styles", () => {
    const preview = buildToolPreview({
      api_key: "plain-looking",
      apiKey: "plain-looking",
      "API-KEY": "plain-looking",
      password: "hunter2",
      clientSecret: "s",
      refreshToken: "r",
      authorization: "whatever",
      keep: "visible",
    });

    const parsed = parse(preview?.json ?? "") as Record<string, unknown>;
    expect(parsed.keep).toBe("visible");
    for (const key of [
      "api_key",
      "apiKey",
      "API-KEY",
      "password",
      "clientSecret",
      "refreshToken",
      "authorization",
    ]) {
      expect(parsed[key]).toBe("[redacted]");
    }
    expect(preview?.redactedPaths).toContain("password");
    expect(preview?.redactedPaths).not.toContain("keep");
  });

  it("redacts credential key spellings that do not end at the word", () => {
    // A suffix-anchored rule misses every one of these, and none of them match a value pattern
    // either — a plain password and a bcrypt hash look like ordinary strings.
    const preview = buildToolPreview({
      passwd: "hunter2",
      pwd: "hunter2",
      password_hash: "$2b$10$abcdefghijklmnop",
      passwordConfirmation: "hunter2",
      authHeader: "Basic dXNlcjpodW50ZXIy",
      sessionKey: "abc123",
      otpCode: "482913",
    });

    const parsed = parse(preview?.json ?? "") as Record<string, unknown>;
    for (const key of [
      "passwd",
      "pwd",
      "password_hash",
      "passwordConfirmation",
      "authHeader",
      "sessionKey",
      "otpCode",
    ]) {
      expect(parsed[key]).toBe("[redacted]");
    }
  });

  it("keeps the author family visible", () => {
    // `author` starts with `auth` but is ordinary metadata on GitHub and Slack payloads, so
    // redacting it would gut the preview on the calls that need it most.
    const preview = buildToolPreview({
      author: "maddhruv",
      authors: ["a", "b"],
      auth: "t0ps3cret",
    });

    const parsed = parse(preview?.json ?? "") as Record<string, unknown>;
    expect(parsed.author).toBe("maddhruv");
    expect(parsed.authors).toEqual(["a", "b"]);
    expect(parsed.auth).toBe("[redacted]");
  });

  it("redacts credential-shaped values hidden under an innocuous key", () => {
    const preview = buildToolPreview({
      note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g",
      slack: "xoxb-1234567890-abcdefghijkl",
      prose: "The deployment finished and the report is attached.",
    });

    const parsed = parse(preview?.json ?? "") as Record<string, unknown>;
    expect(parsed.note).toBe("[redacted]");
    expect(parsed.jwt).toBe("[redacted]");
    expect(parsed.slack).toBe("[redacted]");
    expect(parsed.prose).toBe("The deployment finished and the report is attached.");
  });

  it("redacts a PEM private key block", () => {
    const preview = buildToolPreview({
      blob: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
    });

    expect((parse(preview?.json ?? "") as Record<string, unknown>).blob).toBe("[redacted]");
  });

  it("reports nested redacted paths precisely", () => {
    const preview = buildToolPreview({
      connection: { host: "db.internal", password: "hunter2" },
      items: [{ token: "abc" }],
    });

    expect(preview?.redactedPaths).toContain("connection.password");
    expect(preview?.redactedPaths).toContain("items[0].token");
    expect(preview?.redactedPaths).not.toContain("connection.host");
  });

  it("caps array breadth and flags truncation", () => {
    const preview = buildToolPreview({ rows: Array.from({ length: 100 }, (_, i) => i) });

    const parsed = parse(preview?.json ?? "") as { rows: number[] };
    expect(parsed.rows).toHaveLength(20);
    expect(preview?.truncated).toBe(true);
  });

  it("caps long strings without losing the head of the value", () => {
    const preview = buildToolPreview({ body: "x".repeat(5_000) });

    const parsed = parse(preview?.json ?? "") as { body: string };
    expect(parsed.body.length).toBeLessThan(5_000);
    expect(parsed.body.startsWith("xxxx")).toBe(true);
    expect(preview?.truncated).toBe(true);
  });

  it("stops at the depth ceiling rather than walking forever", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 30; i += 1) deep = { next: deep };

    const preview = buildToolPreview(deep);

    expect(preview?.truncated).toBe(true);
    expect(preview?.json).toContain("[depth limit]");
  });

  it("fails closed on a cyclic value instead of throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    const preview = buildToolPreview(cyclic);

    expect(preview).toBeDefined();
    expect(preview?.truncated).toBe(true);
  });

  it("reports the original size so a reader can say how much is missing", () => {
    const value = { rows: Array.from({ length: 100 }, (_, i) => i) };

    expect(buildToolPreview(value)?.bytes).toBe(JSON.stringify(value).length);
  });

  it("previews a bare string or array, not only an object", () => {
    expect(parse(buildToolPreview("hello")?.json ?? "")).toBe("hello");
    expect(parse(buildToolPreview([1, 2, 3])?.json ?? "")).toEqual([1, 2, 3]);
  });

  it("never emits a preview larger than the hard character ceiling", () => {
    const preview = buildToolPreview(Array.from({ length: 20 }, () => ({ text: "y".repeat(790) })));

    expect((preview?.json.length ?? 0) <= 8_000).toBe(true);
    expect(preview?.truncated).toBe(true);
  });

  it("keeps an over-ceiling preview parseable", () => {
    // Slicing serialized JSON cut mid-token, so the reader got a blob that would not parse and the
    // row rendered nothing at all. The capped payload has to stay valid JSON.
    const preview = buildToolPreview(
      Array.from({ length: 20 }, () => ({ text: `"y\\${"y".repeat(790)}` }))
    );

    expect(preview?.truncated).toBe(true);
    expect((preview?.json.length ?? 0) <= 8_000).toBe(true);
    const parsed = parse(preview?.json ?? "");
    expect(typeof parsed).toBe("string");
    expect(parsed as string).toContain("[truncated]");
  });
});
