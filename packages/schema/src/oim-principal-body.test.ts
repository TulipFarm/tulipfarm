import { describe, expect, it } from "vitest";
import { oimLiveAuthorizationAllowed, oimPrincipalBody } from "./oim";

const objectSchema = { type: "object" };

describe("oimPrincipalBody", () => {
  it("clones the template and inserts the proven subject", () => {
    const template = { subject: { type: "user" }, operation: "read" };
    const body = oimPrincipalBody({ template, pointer: "/subject/identifier" }, "account-123", {
      type: "object",
      required: ["subject", "operation"],
      properties: {
        subject: {
          type: "object",
          required: ["type", "identifier"],
          properties: {
            type: { const: "user" },
            identifier: { type: "string" },
          },
        },
        operation: { const: "read" },
      },
    });

    expect(body).toEqual({
      subject: { type: "user", identifier: "account-123" },
      operation: "read",
    });
    expect(template).toEqual({ subject: { type: "user" }, operation: "read" });
  });

  it("decodes RFC 6901 path segments", () => {
    expect(
      oimPrincipalBody(
        { template: { "subject/id": {} }, pointer: "/subject~1id/~0value" },
        "x",
        objectSchema
      )
    ).toEqual({ "subject/id": { "~value": "x" } });
  });

  it.each([
    ["/subject/__proto__", "unsafe segment"],
    ["/constructor/identifier", "unsafe segment"],
    ["/subject/prototype", "unsafe segment"],
    ["/subjects/0/identifier", "not an object"],
    ["/missing/identifier", "not an object"],
    ["/subject/type", "must be absent"],
  ])("rejects unsafe binding %s", (pointer, message) => {
    const template =
      pointer === "/subjects/0/identifier"
        ? { subjects: [{ type: "user" }] }
        : { subject: { type: "user" } };
    expect(() => oimPrincipalBody({ template, pointer }, "account-123", objectSchema)).toThrow(
      message
    );
  });

  it("rejects a completed body that fails the operation request schema", () => {
    expect(() =>
      oimPrincipalBody(
        { template: { subject: { type: "user" } }, pointer: "/subject/identifier" },
        "account-123",
        { type: "object", required: ["operation"] }
      )
    ).toThrow("does not satisfy request schema");
  });
});

describe("oimLiveAuthorizationAllowed", () => {
  it("allows only an explicit Boolean true", () => {
    expect(oimLiveAuthorizationAllowed({ hasPermission: true }, "/hasPermission")).toBe(true);
  });

  it.each([
    [{ hasPermission: false }, "/hasPermission"],
    [{}, "/hasPermission"],
    [{ hasPermission: "true" }, "/hasPermission"],
    [{ hasPermission: 1 }, "/hasPermission"],
    [{ nested: null }, "/nested/hasPermission"],
    [{ nested: [true] }, "/nested/0"],
    [{ hasPermission: true }, "/__proto__/hasPermission"],
    [{ hasPermission: true }, "hasPermission"],
  ])("fails closed for malformed or denied result %#", (response, pointer) => {
    expect(oimLiveAuthorizationAllowed(response, pointer)).toBe(false);
  });
});
