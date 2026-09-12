import { describe, expect, it } from "vitest";
import {
  analyzeAuthChallenges,
  detectAuthChallenge,
  isSessionHeader,
  parseAuthChallenges,
} from "./auth-challenge";

const ORIGIN = "https://api.example.com";

describe("parseAuthChallenges", () => {
  it("reads a scheme with no arguments", () => {
    expect(parseAuthChallenges("Bearer")).toEqual([{ scheme: "bearer", params: {} }]);
  });

  it("reads quoted parameters and unescapes them", () => {
    expect(parseAuthChallenges('Basic realm="Acme \\"Prod\\""')).toEqual([
      { scheme: "basic", params: { realm: 'Acme "Prod"' } },
    ]);
  });

  it("separates two challenges whose boundary is only marked by a comma", () => {
    // The comma is both a parameter separator and a challenge separator, so `Basic` is only
    // recognisable as a new scheme because no `=` follows it.
    expect(parseAuthChallenges('Bearer realm="api", Basic realm="legacy"')).toEqual([
      { scheme: "bearer", params: { realm: "api" } },
      { scheme: "basic", params: { realm: "legacy" } },
    ]);
  });

  it("parses the ambiguous multi-parameter example from RFC 9110", () => {
    expect(
      parseAuthChallenges(
        'Newauth realm="apps", type=1, title="Login to \\"apps\\"", Basic realm="simple"'
      )
    ).toEqual([
      { scheme: "newauth", params: { realm: "apps", type: "1", title: 'Login to "apps"' } },
      { scheme: "basic", params: { realm: "simple" } },
    ]);
  });

  it("reads a token68 argument without mistaking the next scheme for part of it", () => {
    expect(parseAuthChallenges("Negotiate a87421bff==, Basic realm='x'")).toEqual([
      { scheme: "negotiate", params: {}, token68: "a87421bff==" },
      { scheme: "basic", params: { realm: "'x'" } },
    ]);
  });

  it("returns nothing for an absent header", () => {
    expect(parseAuthChallenges(undefined)).toEqual([]);
  });
});

describe("analyzeAuthChallenges", () => {
  it("binds the rule to the request origin, never to a realm the response chose", () => {
    // A provider that answers with a realm naming another host must not be able to point a
    // person's credential at that host.
    const [rule] = analyzeAuthChallenges(
      parseAuthChallenges('Bearer realm="https://evil.example.net/"'),
      ORIGIN
    ).supported;
    expect(rule?.origin).toBe(ORIGIN);
    expect(rule?.realm).toBe("https://evil.example.net/");
  });

  it("proposes an Authorization header for bearer and basic", () => {
    const { supported } = analyzeAuthChallenges(
      parseAuthChallenges("Bearer, Basic realm=api"),
      ORIGIN
    );
    expect(supported).toEqual([
      {
        location: "header",
        name: "authorization",
        origin: ORIGIN,
        scheme: "bearer",
        valuePrefix: "Bearer ",
        encoding: "verbatim",
      },
      {
        location: "header",
        name: "authorization",
        origin: ORIGIN,
        scheme: "basic",
        realm: "api",
        valuePrefix: "Basic ",
        encoding: "basic_userinfo",
      },
    ]);
  });

  it("refuses schemes that cannot be satisfied by attaching one stored value", () => {
    const { supported, unsupported } = analyzeAuthChallenges(
      parseAuthChallenges("Negotiate, NTLM, Digest realm=x"),
      ORIGIN
    );
    expect(supported).toEqual([]);
    expect(unsupported.map((entry) => entry.reason)).toEqual([
      "multi_round_scheme",
      "multi_round_scheme",
      "multi_round_scheme",
    ]);
  });
});

describe("isSessionHeader", () => {
  it("refuses a copied browser session regardless of casing or padding", () => {
    expect(isSessionHeader(" Cookie ")).toBe(true);
    expect(isSessionHeader("SET-COOKIE")).toBe(true);
    expect(isSessionHeader("x-api-key")).toBe(false);
  });
});

describe("detectAuthChallenge", () => {
  it("ignores statuses that are not authentication failures", () => {
    expect(detectAuthChallenge(500, { "www-authenticate": "Bearer" }, ORIGIN)).toBeUndefined();
  });

  it("reports a 401 that carried no challenge rather than inventing one", () => {
    expect(detectAuthChallenge(401, {}, ORIGIN)).toEqual({
      supported: [],
      unsupported: [{ scheme: "", reason: "no_challenge" }],
    });
  });

  it("analyzes a 403 that carried a challenge", () => {
    const analysis = detectAuthChallenge(403, { "www-authenticate": "Bearer" }, ORIGIN);
    expect(analysis?.supported.map((rule) => rule.scheme)).toEqual(["bearer"]);
  });
});
