import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validateBase64Secret, validateEnvironment, validateUriPrefix } from "./index";

/** Generate a valid 32-byte base64 secret */
function secret32(): string {
  return randomBytes(32).toString("base64");
}

/** Full valid env record for all required vars */
function validEnv(): Record<string, string | undefined> {
  return {
    MONGODB_URI: "mongodb://localhost:27017/tulipfarm",
    REDIS_URL: "redis://localhost:6379",
    SOUL_PATH: "./soul",
    ENCRYPTION_KEY: secret32(),
    JWT_SECRET: secret32(),
    WEBHOOK_SIGNING_SECRET: secret32(),
  };
}

describe("validateEnvironment", () => {
  it("passes with all valid vars", () => {
    const exit = vi.fn();
    validateEnvironment(validEnv(), exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits on missing single required var", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.ENCRYPTION_KEY = undefined;
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits and lists all missing when multiple vars absent", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.ENCRYPTION_KEY = undefined;
    env.JWT_SECRET = undefined;
    env.WEBHOOK_SIGNING_SECRET = undefined;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ENCRYPTION_KEY"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("JWT_SECRET"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("WEBHOOK_SIGNING_SECRET"));
    errorSpy.mockRestore();
  });

  it("exits when ENCRYPTION_KEY is invalid base64", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.ENCRYPTION_KEY = "not-valid-base64!!!";
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when ENCRYPTION_KEY is wrong byte length", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.ENCRYPTION_KEY = randomBytes(16).toString("base64"); // 16 bytes, not 32
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when JWT_SECRET is wrong byte length", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.JWT_SECRET = randomBytes(16).toString("base64");
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when WEBHOOK_SIGNING_SECRET is not valid base64", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.WEBHOOK_SIGNING_SECRET = "bad!!!";
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when MONGODB_URI has wrong prefix", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.MONGODB_URI = "http://localhost:27017/tulipfarm";
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when REDIS_URL has wrong prefix", () => {
    const exit = vi.fn();
    const env = validEnv();
    env.REDIS_URL = "http://localhost:6379";
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when SESSION_TTL_SECONDS is not a number", () => {
    const exit = vi.fn();
    const env = { ...validEnv(), SESSION_TTL_SECONDS: "abc" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("exits when SESSION_TTL_SECONDS is negative", () => {
    const exit = vi.fn();
    const env = { ...validEnv(), SESSION_TTL_SECONDS: "-1" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateEnvironment(env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("passes when SESSION_TTL_SECONDS is absent (optional)", () => {
    const exit = vi.fn();
    const env = validEnv();
    // SESSION_TTL_SECONDS not set — should pass
    validateEnvironment(env, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("validateBase64Secret", () => {
  it("passes with valid 32-byte base64", () => {
    const exit = vi.fn();
    const env = { TEST_KEY: secret32() };
    validateBase64Secret("TEST_KEY", env, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with wrong byte length", () => {
    const exit = vi.fn();
    const env = { TEST_KEY: randomBytes(16).toString("base64") };
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateBase64Secret("TEST_KEY", env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});

describe("validateUriPrefix", () => {
  it("passes with valid prefix", () => {
    const exit = vi.fn();
    const env = { DB: "mongodb://localhost" };
    validateUriPrefix("DB", ["mongodb://", "mongodb+srv://"], env, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("passes with mongodb+srv:// prefix", () => {
    const exit = vi.fn();
    const env = { DB: "mongodb+srv://cluster.example.com" };
    validateUriPrefix("DB", ["mongodb://", "mongodb+srv://"], env, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with wrong prefix", () => {
    const exit = vi.fn();
    const env = { DB: "http://localhost" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    validateUriPrefix("DB", ["mongodb://", "mongodb+srv://"], env, exit);
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
