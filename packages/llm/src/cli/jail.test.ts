import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCliJail, jailedEnv } from "./jail";

describe("createCliJail", () => {
  it("creates a private directory and removes it on cleanup", () => {
    const jail = createCliJail("tf-test-");
    expect(existsSync(jail.home)).toBe(true);
    writeFileSync(`${jail.home}/scratch`, "x");
    jail.cleanup();
    expect(existsSync(jail.home)).toBe(false);
  });

  it("hands out a distinct directory per call", () => {
    const a = createCliJail("tf-test-");
    const b = createCliJail("tf-test-");
    try {
      expect(a.home).not.toBe(b.home);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("does not throw when cleanup runs twice", () => {
    const jail = createCliJail("tf-test-");
    jail.cleanup();
    expect(() => jail.cleanup()).not.toThrow();
  });
});

describe("jailedEnv", () => {
  // The whole point of the allowlist is that it is a *deny-by-default* boundary: a secret added to
  // the API's env later must not silently become visible to a CLI subprocess.
  const host: NodeJS.ProcessEnv = {
    HOME: "/Users/real",
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    DATABASE_URL: "postgres://secret",
    ENCRYPTION_KEY: "encryption-secret",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-anthropic",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SOME_FUTURE_SECRET: "not-yet-invented",
  };

  it("pins HOME to the jail rather than the host user's home", () => {
    expect(jailedEnv(host, "/tmp/jail").HOME).toBe("/tmp/jail");
  });

  it("copies only allowlisted host vars", () => {
    const env = jailedEnv(host, "/tmp/jail");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it.each([
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "SOME_FUTURE_SECRET",
  ])("withholds %s", (name) => {
    expect(jailedEnv(host, "/tmp/jail")[name]).toBeUndefined();
  });

  it("withholds another provider's credential unless the caller opted it in", () => {
    expect(jailedEnv(host, "/tmp/jail").ANTHROPIC_API_KEY).toBeUndefined();
    expect(jailedEnv(host, "/tmp/jail", ["ANTHROPIC_API_KEY"]).ANTHROPIC_API_KEY).toBe(
      "sk-anthropic"
    );
  });

  it("omits an allowlisted var that the host does not define, rather than setting it undefined", () => {
    const env = jailedEnv({ PATH: "/usr/bin" }, "/tmp/jail");
    expect("LANG" in env).toBe(false);
  });

  it("lets caller-supplied vars win over the passthrough", () => {
    const env = jailedEnv(host, "/tmp/jail", ["ANTHROPIC_API_KEY"], {
      ANTHROPIC_API_KEY: "scoped-token",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("scoped-token");
  });

  it("cannot be tricked into re-exposing the host HOME through extraPassthrough", () => {
    expect(jailedEnv(host, "/tmp/jail", ["HOME"]).HOME).toBe("/tmp/jail");
  });
});
