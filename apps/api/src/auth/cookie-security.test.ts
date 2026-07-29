import { afterEach, describe, expect, it } from "vitest";
import { sessionCookieOptions, useSecureCookies } from "./cookie-security";

describe("useSecureCookies", () => {
  it("is true when PUBLIC_URL is https", () => {
    expect(useSecureCookies({ PUBLIC_URL: "https://tulip.example.com" })).toBe(true);
  });

  it("is false when PUBLIC_URL is plain http, even in production", () => {
    // The shipped image always sets NODE_ENV=production but serves http on :8080. A `Secure`
    // cookie there is discarded by the browser, so login would silently never stick.
    expect(
      useSecureCookies({ PUBLIC_URL: "http://192.168.1.20:8080", NODE_ENV: "production" })
    ).toBe(false);
  });

  it("falls back to NODE_ENV when PUBLIC_URL is unset", () => {
    expect(useSecureCookies({ NODE_ENV: "production" })).toBe(true);
    expect(useSecureCookies({ NODE_ENV: "development" })).toBe(false);
    expect(useSecureCookies({})).toBe(false);
  });
});

describe("sessionCookieOptions", () => {
  const original = process.env.PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = original;
  });

  it("carries the hardening attributes and the resolved secure flag", () => {
    process.env.PUBLIC_URL = "https://tulip.example.com";

    expect(sessionCookieOptions(3600)).toEqual({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
      maxAge: 3600,
    });
  });
});
