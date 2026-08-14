import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAuthError, parseCodexAuth, readRotatedCodexAuth, writeCodexHome } from "./codex-auth";

const subscription = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    tokens: { access_token: "at", refresh_token: "rt", account_id: "acc" },
    last_refresh: "2026-01-01T00:00:00Z",
    ...overrides,
  });

let jail: string;

beforeEach(() => {
  jail = mkdtempSync(join(tmpdir(), "tf-codex-auth-"));
});

afterEach(() => {
  rmSync(jail, { recursive: true, force: true });
});

describe("parseCodexAuth", () => {
  it("accepts a subscription credential and returns it parsed", () => {
    expect(parseCodexAuth(subscription())).toMatchObject({ tokens: { refresh_token: "rt" } });
  });

  it("rejects an API-key credential by name, not as a corrupt file", () => {
    // The provider is subscription-only on purpose: accepting this would bill the operator's
    // OpenAI account for turns TulipFarm deliberately reports as unpriced.
    const error = (() => {
      try {
        parseCodexAuth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live" }));
      } catch (err) {
        return err as Error;
      }
    })();

    expect(error).toBeInstanceOf(CodexAuthError);
    expect(error?.message).toMatch(/subscription-only/);
    expect(error?.message).toMatch(/OpenAI provider/);
    // The rejection must not echo the key the operator just pasted.
    expect(error?.message).not.toContain("sk-live");
  });

  it("rejects a blob whose refresh token is missing or empty", () => {
    expect(() => parseCodexAuth(JSON.stringify({ tokens: { access_token: "at" } }))).toThrow(
      /refresh_token/
    );
    expect(() => parseCodexAuth(subscription({ tokens: { refresh_token: "" } }))).toThrow(
      CodexAuthError
    );
  });

  it.each(["not json at all", "[]", "null", '"a string"', ""])("rejects %s", (raw) => {
    expect(() => parseCodexAuth(raw)).toThrow(CodexAuthError);
  });
});

describe("writeCodexHome", () => {
  it("writes auth.json owner-only, inside the jail", () => {
    const home = writeCodexHome(jail, subscription());

    expect(home.startsWith(jail)).toBe(true);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(subscription());
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  });
});

describe("readRotatedCodexAuth", () => {
  it("returns the rotated credential when the CLI refreshed it", () => {
    const home = writeCodexHome(jail, subscription());
    const rotated = subscription({ tokens: { refresh_token: "rt2", access_token: "at2" } });
    writeFileSync(join(home, "auth.json"), rotated);

    expect(readRotatedCodexAuth(home, subscription())).toBe(rotated);
  });

  it("returns undefined when nothing changed, so no secret is rewritten", () => {
    const home = writeCodexHome(jail, subscription());

    expect(readRotatedCodexAuth(home, subscription())).toBeUndefined();
  });

  it("ignores a truncated write rather than overwriting a working credential", () => {
    // The child can be SIGKILLed mid-flush; a half-written file must never replace a good secret.
    const home = writeCodexHome(jail, subscription());
    writeFileSync(join(home, "auth.json"), '{"tokens": {"refresh_');

    expect(readRotatedCodexAuth(home, subscription())).toBeUndefined();
  });

  it("ignores a file the CLI deleted", () => {
    const home = writeCodexHome(jail, subscription());
    rmSync(join(home, "auth.json"));

    expect(readRotatedCodexAuth(home, subscription())).toBeUndefined();
  });

  it("ignores a rotation that downgraded to an API key", () => {
    const home = writeCodexHome(jail, subscription());
    writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-live" }));

    expect(readRotatedCodexAuth(home, subscription())).toBeUndefined();
  });
});
