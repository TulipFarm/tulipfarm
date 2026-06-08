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

  it("is false when PUBLIC_URL is unset", () => {
    // No stub — PUBLIC_URL is absent in the test environment.
    expect(cookieSecure()).toBe(false);
  });

  it("is false for a malformed PUBLIC_URL", () => {
    vi.stubEnv("PUBLIC_URL", "not a url");
    expect(cookieSecure()).toBe(false);
  });
});
