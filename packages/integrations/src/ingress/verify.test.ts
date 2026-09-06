import { createHmac, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import type { OimVerification } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { canonicalSigningInput, type DeliveryRequest, verifyDelivery } from "./verify";

const BODY = Buffer.from('{"type":"forecast_updated","id":7}', "utf8");
const SECRET = "whsec_top_secret";
const NOW = 1_800_000_000;

function request(headers: Record<string, string>, body: Uint8Array = BODY): DeliveryRequest {
  return { rawBody: body, headers };
}

function hmac(digest: "sha256" | "sha512", data: Uint8Array, secret = SECRET): string {
  return createHmac(digest, secret).update(Buffer.from(data)).digest("hex");
}

const HMAC: OimVerification = {
  scheme: "hmac_sha256",
  secretSlot: "webhook_secret",
  signatureHeader: "x-signature",
  signatureEncoding: "hex",
};

describe("shared_secret", () => {
  const verification: OimVerification = {
    scheme: "shared_secret",
    secretSlot: "webhook_secret",
    signatureHeader: "x-webhook-token",
  };

  it("accepts the configured Secret", () => {
    expect(verifyDelivery(verification, request({ "x-webhook-token": SECRET }), SECRET)).toEqual({
      ok: true,
    });
  });

  it("refuses a different Secret", () => {
    expect(verifyDelivery(verification, request({ "x-webhook-token": "wrong" }), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a request that presents nothing", () => {
    expect(verifyDelivery(verification, request({}), SECRET)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("refuses an empty header rather than comparing two empty values", () => {
    // Zero-length equals zero-length, which is how a check that looks correct accepts nothing.
    expect(verifyDelivery(verification, request({ "x-webhook-token": "" }), SECRET)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });
});

describe("HMAC", () => {
  it("accepts a signature over the raw body", () => {
    const signature = hmac("sha256", BODY);
    expect(verifyDelivery(HMAC, request({ "x-signature": signature }), SECRET)).toEqual({
      ok: true,
    });
  });

  it("accepts SHA-512 when declared", () => {
    const verification = { ...HMAC, scheme: "hmac_sha512" } as OimVerification;
    const signature = hmac("sha512", BODY);
    expect(verifyDelivery(verification, request({ "x-signature": signature }), SECRET)).toEqual({
      ok: true,
    });
  });

  it("refuses a SHA-256 signature when SHA-512 is declared", () => {
    const verification = { ...HMAC, scheme: "hmac_sha512" } as OimVerification;
    expect(
      verifyDelivery(verification, request({ "x-signature": hmac("sha256", BODY) }), SECRET)
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("strips a declared prefix before decoding", () => {
    const verification = { ...HMAC, signaturePrefix: "sha256=" };
    const presented = `sha256=${hmac("sha256", BODY)}`;
    expect(verifyDelivery(verification, request({ "x-signature": presented }), SECRET)).toEqual({
      ok: true,
    });
  });

  it("refuses a signature that does not carry the declared prefix", () => {
    const verification = { ...HMAC, signaturePrefix: "sha256=" };
    expect(
      verifyDelivery(verification, request({ "x-signature": hmac("sha256", BODY) }), SECRET)
    ).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("accepts base64 and base64url encodings", () => {
    const digest = createHmac("sha256", SECRET).update(BODY).digest();
    expect(
      verifyDelivery(
        { ...HMAC, signatureEncoding: "base64" },
        request({ "x-signature": digest.toString("base64") }),
        SECRET
      )
    ).toEqual({ ok: true });
    expect(
      verifyDelivery(
        { ...HMAC, signatureEncoding: "base64url" },
        request({ "x-signature": digest.toString("base64url") }),
        SECRET
      )
    ).toEqual({ ok: true });
  });

  it("refuses a signature that is not the declared encoding", () => {
    expect(verifyDelivery(HMAC, request({ "x-signature": "not-hex!!" }), SECRET)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  it("refuses a truncated signature rather than comparing a prefix", () => {
    const short = hmac("sha256", BODY).slice(0, 40);
    expect(verifyDelivery(HMAC, request({ "x-signature": short }), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a body altered after signing", () => {
    const signature = hmac("sha256", BODY);
    const tampered = Buffer.from('{"type":"forecast_updated","id":8}', "utf8");
    expect(verifyDelivery(HMAC, request({ "x-signature": signature }, tampered), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("finds the header whatever case the provider used", () => {
    expect(verifyDelivery(HMAC, request({ "X-Signature": hmac("sha256", BODY) }), SECRET)).toEqual({
      ok: true,
    });
  });
});

describe("replay window", () => {
  const verification: OimVerification = {
    ...HMAC,
    signingInput: "{timestamp}.{body}",
    timestampHeader: "x-timestamp",
    toleranceSeconds: 300,
  };

  function signedAt(seconds: number): Record<string, string> {
    const input = canonicalSigningInput("{timestamp}.{body}", BODY, String(seconds));
    return { "x-timestamp": String(seconds), "x-signature": hmac("sha256", input) };
  }

  it("accepts a delivery inside the window", () => {
    expect(verifyDelivery(verification, request(signedAt(NOW - 10)), SECRET, NOW)).toEqual({
      ok: true,
      signedAt: NOW - 10,
    });
  });

  it("refuses a captured delivery replayed later", () => {
    expect(verifyDelivery(verification, request(signedAt(NOW - 3600)), SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("refuses a delivery dated in the future", () => {
    // A forward timestamp is as replayable as a stale one: it stays valid for the whole skew.
    expect(verifyDelivery(verification, request(signedAt(NOW + 3600)), SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("refuses a delivery with no timestamp at all", () => {
    expect(
      verifyDelivery(verification, request({ "x-signature": hmac("sha256", BODY) }), SECRET, NOW)
    ).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("refuses a timestamp that is not a number", () => {
    expect(
      verifyDelivery(
        verification,
        request({ "x-timestamp": "yesterday", "x-signature": hmac("sha256", BODY) }),
        SECRET,
        NOW
      )
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("refuses a fresh timestamp swapped onto a body signed with another", () => {
    const headers = signedAt(NOW - 10);
    expect(
      verifyDelivery(verification, request({ ...headers, "x-timestamp": String(NOW) }), SECRET, NOW)
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("defaults the window when the manifest sets none", () => {
    const { toleranceSeconds: _unset, ...withoutTolerance } = verification;
    expect(
      verifyDelivery(withoutTolerance as OimVerification, request(signedAt(NOW - 299)), SECRET, NOW)
    ).toMatchObject({ ok: true });
    expect(
      verifyDelivery(withoutTolerance as OimVerification, request(signedAt(NOW - 301)), SECRET, NOW)
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});

describe("public-key schemes", () => {
  const ed = generateKeyPairSync("ed25519");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const edPem = ed.publicKey.export({ type: "spki", format: "pem" }).toString();
  const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();

  const edVerification: OimVerification = {
    scheme: "ed25519",
    secretSlot: "public_key",
    signatureHeader: "x-signature",
    signatureEncoding: "base64",
  };
  const rsaVerification: OimVerification = { ...edVerification, scheme: "rsa_sha256" };

  it("accepts a genuine Ed25519 signature", () => {
    const signature = cryptoSign(null, BODY, ed.privateKey).toString("base64");
    expect(verifyDelivery(edVerification, request({ "x-signature": signature }), edPem)).toEqual({
      ok: true,
    });
  });

  it("refuses an Ed25519 signature from another key", () => {
    const other = generateKeyPairSync("ed25519");
    const signature = cryptoSign(null, BODY, other.privateKey).toString("base64");
    expect(verifyDelivery(edVerification, request({ "x-signature": signature }), edPem)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts a genuine RSA signature", () => {
    const signature = cryptoSign("sha256", BODY, rsa.privateKey).toString("base64");
    expect(verifyDelivery(rsaVerification, request({ "x-signature": signature }), rsaPem)).toEqual({
      ok: true,
    });
  });

  it("refuses an RSA key where Ed25519 was declared", () => {
    // Verifying with whatever key happens to be configured would let a slot swap change the scheme.
    const signature = cryptoSign("sha256", BODY, rsa.privateKey).toString("base64");
    expect(verifyDelivery(edVerification, request({ "x-signature": signature }), rsaPem)).toEqual({
      ok: false,
      reason: "malformed_key",
    });
  });

  it("refuses a slot that does not hold a key", () => {
    expect(verifyDelivery(edVerification, request({ "x-signature": "AAAA" }), "not-a-pem")).toEqual(
      { ok: false, reason: "malformed_key" }
    );
  });
});

describe("JWT", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  const base = {
    scheme: "jwt",
    secretSlot: "public_key",
    signatureHeader: "authorization",
  } as OimVerification;

  function token(
    header: Record<string, unknown>,
    claims: Record<string, unknown>,
    sign: (signingInput: Buffer) => Buffer
  ): string {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const signingInput = `${encode(header)}.${encode(claims)}`;
    return `${signingInput}.${sign(Buffer.from(signingInput, "utf8")).toString("base64url")}`;
  }

  const claims = {
    iss: "https://provider.example",
    aud: "tulipfarm",
    exp: NOW + 60,
  };

  const rs256 = () =>
    token({ alg: "RS256", typ: "JWT" }, claims, (input) =>
      cryptoSign("sha256", input, rsa.privateKey)
    );

  it("accepts a token signed by the configured key", () => {
    const verification = { ...base, issuer: claims.iss, audience: claims.aud };
    expect(
      verifyDelivery(verification, request({ authorization: `Bearer ${rs256()}` }), rsaPem, NOW)
    ).toMatchObject({ ok: true });
  });

  it("accepts the token without the Bearer prefix", () => {
    expect(verifyDelivery(base, request({ authorization: rs256() }), rsaPem, NOW)).toMatchObject({
      ok: true,
    });
  });

  it("refuses an algorithm outside the suite", () => {
    const forged = token({ alg: "none" }, claims, () => Buffer.alloc(0));
    expect(verifyDelivery(base, request({ authorization: forged }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "unsupported_algorithm",
    });
  });

  it("refuses an RS256 token downgraded to HS256 and signed with the public key", () => {
    // The classic algorithm-confusion forgery: trusting the token's own `alg` turns a public key
    // into a signing key, and every "verified" delivery is attacker-authored.
    const forged = token({ alg: "HS256" }, claims, (input) =>
      createHmac("sha256", rsaPem).update(input).digest()
    );
    expect(verifyDelivery(base, request({ authorization: forged }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "unsupported_algorithm",
    });
  });

  it("refuses a token from an untrusted issuer", () => {
    const verification = { ...base, issuer: "https://expected.example" };
    expect(verifyDelivery(verification, request({ authorization: rs256() }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "untrusted_claims",
    });
  });

  it("refuses a token minted for somebody else", () => {
    const verification = { ...base, audience: "another-tenant" };
    expect(verifyDelivery(verification, request({ authorization: rs256() }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "untrusted_claims",
    });
  });

  it("accepts an audience array that names this deployment", () => {
    const verification = { ...base, audience: "tulipfarm" };
    const multi = token({ alg: "RS256" }, { ...claims, aud: ["other", "tulipfarm"] }, (input) =>
      cryptoSign("sha256", input, rsa.privateKey)
    );
    expect(
      verifyDelivery(verification, request({ authorization: multi }), rsaPem, NOW)
    ).toMatchObject({ ok: true });
  });

  it("refuses a token with no expiry", () => {
    // Without one it never stops being replayable, so absence is a refusal, not a default.
    const forever = token({ alg: "RS256" }, { iss: claims.iss }, (input) =>
      cryptoSign("sha256", input, rsa.privateKey)
    );
    expect(verifyDelivery(base, request({ authorization: forever }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "untrusted_claims",
    });
  });

  it("refuses an expired token", () => {
    const expired = token({ alg: "RS256" }, { ...claims, exp: NOW - 3600 }, (input) =>
      cryptoSign("sha256", input, rsa.privateKey)
    );
    expect(verifyDelivery(base, request({ authorization: expired }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("refuses a token that is not yet valid", () => {
    const early = token({ alg: "RS256" }, { ...claims, nbf: NOW + 7200 }, (input) =>
      cryptoSign("sha256", input, rsa.privateKey)
    );
    expect(verifyDelivery(base, request({ authorization: early }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("refuses a token whose payload was edited after signing", () => {
    const [header, , signature] = rs256().split(".");
    const swapped = Buffer.from(
      JSON.stringify({ ...claims, iss: "https://evil.example" }),
      "utf8"
    ).toString("base64url");
    expect(
      verifyDelivery(
        base,
        request({ authorization: `${header}.${swapped}.${signature}` }),
        rsaPem,
        NOW
      )
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses anything that is not three segments", () => {
    expect(verifyDelivery(base, request({ authorization: "a.b" }), rsaPem, NOW)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });
});

describe("the Secret never escapes", () => {
  it("keeps the Secret out of every outcome, for every scheme", () => {
    const outcomes = [
      verifyDelivery(HMAC, request({ "x-signature": "deadbeef" }), SECRET),
      verifyDelivery(HMAC, request({}), SECRET),
      verifyDelivery(
        { scheme: "shared_secret", secretSlot: "s", signatureHeader: "x-t" },
        request({ "x-t": "wrong" }),
        SECRET
      ),
      verifyDelivery(
        { scheme: "jwt", secretSlot: "s", signatureHeader: "authorization" },
        request({ authorization: "a.b.c" }),
        SECRET
      ),
    ];
    expect(JSON.stringify(outcomes)).not.toContain(SECRET);
  });
});

describe("canonicalSigningInput", () => {
  it("splices the body as bytes rather than through a string", () => {
    // Decoding and re-encoding normalizes invalid UTF-8 and silently changes what is hashed.
    const invalid = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]);
    const built = canonicalSigningInput("{body}", invalid, undefined);
    expect(Buffer.from(built).equals(Buffer.from(invalid))).toBe(true);
  });

  it("renders the timestamp into the declared position", () => {
    const built = canonicalSigningInput("v0:{timestamp}:{body}", Buffer.from("hi"), "123");
    expect(Buffer.from(built).toString("utf8")).toBe("v0:123:hi");
  });
});
