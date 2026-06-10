import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieSecure } from "./cookie-secure";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cookieSecure", () => {
  it("is true for an https PUBLIC_URL", () => {
    vi.stubEnv("PUBLIC_URL", "https://app.example.com");
    expect(cookieSecure()).toBe(true);
  });

  it("is false for an http PUBLIC_URL", () => {
    vi.stubEnv("PUBLIC_URL", "http://192.168.1.10:8080");
    expect(cookieSecure()).toBe(false);
  });

  it("falls back to false when PUBLIC_URL is unset outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(cookieSecure()).toBe(false);
  });

  it("falls back to true when PUBLIC_URL is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    // No PUBLIC_URL stub — a prod deploy that forgot it must not ship non-Secure cookies.
    expect(cookieSecure()).toBe(true);
  });

  it("falls back to NODE_ENV for a malformed PUBLIC_URL", () => {
    vi.stubEnv("PUBLIC_URL", "not a url");
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieSecure()).toBe(true);
  });

  it("honors an explicit http PUBLIC_URL even in production (operator opt-in)", () => {
    vi.stubEnv("PUBLIC_URL", "http://192.168.1.10:8080");
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieSecure()).toBe(false);
  });
});
