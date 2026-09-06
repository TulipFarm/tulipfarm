import { describe, expect, it } from "vitest";
import { isCredentialFieldName, projectResponse, redactCredentialFields } from "./oim-response";

describe("redactCredentialFields", () => {
  it("removes credential-shaped fields at every depth", () => {
    const redacted = redactCredentialFields({
      id: "issue-1",
      access_token: "ya29.live",
      nested: { refreshToken: "1//rotate", client_secret: "shh", title: "Kept" },
      items: [{ apiKey: "k-1", name: "Muskan Vijayvargiya" }],
    });

    expect(redacted).toEqual({
      id: "issue-1",
      access_token: "[redacted]",
      nested: { refreshToken: "[redacted]", client_secret: "[redacted]", title: "Kept" },
      items: [{ apiKey: "[redacted]", name: "Muskan Vijayvargiya" }],
    });
    expect(JSON.stringify(redacted)).not.toContain("ya29.live");
    expect(JSON.stringify(redacted)).not.toContain("1//rotate");
  });

  it("keeps field names that merely contain a credential word as a substring", () => {
    expect(isCredentialFieldName("tokenized")).toBe(false);
    expect(isCredentialFieldName("secretary")).toBe(false);
    expect(isCredentialFieldName("bearer_token")).toBe(true);
    expect(isCredentialFieldName("token")).toBe(true);
  });

  it("drops prototype-poisoning keys instead of copying them", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as unknown;

    const redacted = redactCredentialFields(hostile) as Record<string, unknown>;

    expect(redacted).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("stops copying past a bounded depth rather than recursing forever", () => {
    let deep: Record<string, unknown> = { token: "leaf" };
    for (let level = 0; level < 40; level += 1) deep = { deep };

    expect(() => redactCredentialFields(deep)).not.toThrow();
  });
});

describe("projectResponse", () => {
  it("cannot select a field redaction already removed", () => {
    const redacted = redactCredentialFields({ data: { id: "1", access_token: "live" } });

    expect(projectResponse(redacted, ["/data/id", "/data/access_token"])).toEqual({
      data: { id: "1", access_token: "[redacted]" },
    });
  });

  it("preserves array shape and drops unresolvable pointers", () => {
    expect(
      projectResponse({ items: [{ id: "a", drop: 1 }, { id: "b" }] }, ["/items/0/id"])
    ).toEqual({ items: [{ id: "a" }] });
    expect(projectResponse({ a: 1 }, ["/missing"])).toEqual({});
  });
});
