import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { commitActorFromRequest } from "./commit-actor";

describe("commitActorFromRequest", () => {
  it("builds a user actor from an authenticated user principal", () => {
    const req = {
      principal: { kind: "user", id: "u1" },
      user: { _id: "u1", name: "Ada", email: "ada@example.com" },
    } as unknown as FastifyRequest;
    expect(commitActorFromRequest(req)).toEqual({
      principalId: "user:u1",
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("refuses instead of inventing a principal when the request is unauthenticated", () => {
    const req = { principal: undefined, user: undefined } as unknown as FastifyRequest;
    expect(() => commitActorFromRequest(req)).toThrow(/no authenticated principal/);
  });
});
