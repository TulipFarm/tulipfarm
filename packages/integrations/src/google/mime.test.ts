import { describe, expect, it } from "vitest";
import { buildGmailMime, encodeGmailRaw } from "./mime";

describe("buildGmailMime", () => {
  it("assembles a plain-text message with the required headers", () => {
    const mime = buildGmailMime({
      to: "alice@acme.com",
      subject: "Lunch",
      body: "Are we still on for 1pm?",
    });

    expect(mime).toContain("To: alice@acme.com");
    expect(mime).toContain("Subject: Lunch");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime.endsWith("Are we still on for 1pm?")).toBe(true);
  });

  it("includes Cc and Bcc only when present", () => {
    const mime = buildGmailMime({
      to: "alice@acme.com",
      subject: "Hi",
      body: "hello",
      cc: "bob@acme.com",
    });

    expect(mime).toContain("Cc: bob@acme.com");
    expect(mime).not.toContain("Bcc:");
  });

  it("RFC 2047 encodes a subject that carries non-ASCII text", () => {
    const mime = buildGmailMime({ to: "a@b.com", subject: "Déjeuner", body: "x" });
    expect(mime).toContain("Subject: =?UTF-8?B?");
  });

  it("strips CR/LF from a header value so it cannot inject extra headers", () => {
    const mime = buildGmailMime({
      to: "alice@acme.com\r\nBcc: evil@acme.com",
      subject: "Hi",
      body: "x",
    });

    expect(mime).toContain("To: alice@acme.com Bcc: evil@acme.com");
    expect(mime.split("\r\n").filter((line) => line.startsWith("Bcc:"))).toEqual([]);
  });
});

describe("encodeGmailRaw", () => {
  it("round-trips through base64url back to the raw message", () => {
    const message = { to: "a@b.com", subject: "S", body: "B" };
    const decoded = Buffer.from(encodeGmailRaw(message), "base64url").toString("utf8");
    expect(decoded).toBe(buildGmailMime(message));
  });
});
