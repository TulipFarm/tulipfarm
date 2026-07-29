import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CSRF_COOKIE, CSRF_HEADER, csrfHook, generateCsrfToken, makeCsrfHook } from "./csrf";
import { SESSION_COOKIE } from "./middleware";
import type { SessionStore } from "./session-store";

function makeReq(
  opts: {
    method?: string;
    authorization?: string;
    sessionCookie?: string;
    csrfCookie?: string;
    csrfHeader?: string;
  } = {}
): FastifyRequest {
  const { method = "POST", authorization, sessionCookie, csrfCookie, csrfHeader } = opts;
  return {
    method,
    headers: {
      ...(authorization !== undefined && { authorization }),
      ...(csrfHeader !== undefined && { [CSRF_HEADER]: csrfHeader }),
    },
    cookies: {
      ...(sessionCookie !== undefined && { [SESSION_COOKIE]: sessionCookie }),
      ...(csrfCookie !== undefined && { [CSRF_COOKIE]: csrfCookie }),
    },
  } as unknown as FastifyRequest;
}

function makeReply() {
  const send = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  return { code, send, _code: code, _send: send } as unknown as FastifyReply & {
    code: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

describe("generateCsrfToken", () => {
  it("returns 64-char hex string", () => {
    const token = generateCsrfToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("returns unique values", () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });
});

describe("csrfHook", () => {
  it("passes GET requests without CSRF header", async () => {
    const req = makeReq({ method: "GET", sessionCookie: "sid" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("passes HEAD requests", async () => {
    const req = makeReq({ method: "HEAD", sessionCookie: "sid" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("passes OPTIONS requests", async () => {
    const req = makeReq({ method: "OPTIONS", sessionCookie: "sid" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("passes Bearer-authenticated requests without CSRF header", async () => {
    const req = makeReq({ authorization: "Bearer tulip_abc123", sessionCookie: "sid" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("passes unauthenticated requests (no session cookie)", async () => {
    const req = makeReq();
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns 403 when session exists but CSRF cookie missing", async () => {
    const req = makeReq({ sessionCookie: "sid", csrfHeader: "some-token" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("returns 403 when session exists but CSRF header missing", async () => {
    const req = makeReq({ sessionCookie: "sid", csrfCookie: "some-token" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("returns 403 when CSRF cookie and header do not match", async () => {
    const req = makeReq({ sessionCookie: "sid", csrfCookie: "token-a", csrfHeader: "token-b" });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("passes when CSRF cookie and header match", async () => {
    const token = generateCsrfToken();
    const req = makeReq({ sessionCookie: "sid", csrfCookie: token, csrfHeader: token });
    const reply = makeReply();
    await csrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("passes PUT/PATCH/DELETE with matching token", async () => {
    const token = generateCsrfToken();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const req = makeReq({ method, sessionCookie: "sid", csrfCookie: token, csrfHeader: token });
      const reply = makeReply();
      await csrfHook(req, reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
  });
});

describe("makeCsrfHook", () => {
  it("passes a matching double-submit token when the session no longer exists (stale cookie) — requireAuth handles rejection", async () => {
    const store = { read: vi.fn().mockResolvedValue(null) } as unknown as SessionStore;
    const boundCsrfHook = makeCsrfHook(store);
    const token = generateCsrfToken();
    const req = makeReq({ sessionCookie: "stale-sid", csrfCookie: token, csrfHeader: token });
    const reply = makeReply();
    await boundCsrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns 403 when the session exists and its stored csrfToken does not match the header", async () => {
    const store = {
      read: vi.fn().mockResolvedValue({ csrfToken: "server-side-token" }),
    } as unknown as SessionStore;
    const boundCsrfHook = makeCsrfHook(store);
    const token = generateCsrfToken();
    const req = makeReq({ sessionCookie: "sid", csrfCookie: token, csrfHeader: token });
    const reply = makeReply();
    await boundCsrfHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("passes when the session exists and its stored csrfToken matches the header", async () => {
    const token = generateCsrfToken();
    const store = {
      read: vi.fn().mockResolvedValue({ csrfToken: token }),
    } as unknown as SessionStore;
    const boundCsrfHook = makeCsrfHook(store);
    const req = makeReq({ sessionCookie: "sid", csrfCookie: token, csrfHeader: token });
    const reply = makeReply();
    await boundCsrfHook(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
