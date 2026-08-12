import type { CommitActor } from "@tulipfarm/soul";
import type { FastifyRequest } from "fastify";
import type { UserDoc } from "../auth/users";

export function commitActorFromRequest(req: FastifyRequest): CommitActor {
  const principal = req.principal;
  const user = req.user as UserDoc | undefined;
  if (principal?.kind === "user" && user !== undefined) {
    return {
      principalId: `user:${user._id}`,
      name: user.name ?? user.email,
      email: user.email,
    };
  }
  if (principal !== undefined) {
    return {
      principalId: `${principal.kind}:${principal.id}`,
      name: principal.id,
      email: "",
    };
  }
  // Refuse rather than invent a principal: a fabricated "unknown:unauthenticated" actor would write
  // a false entry into the activation ledger. Every caller sits behind an auth preHandler, so this
  // is unreachable in practice — but if that ever changes, fail loudly instead of misattributing.
  throw new Error("commitActorFromRequest: no authenticated principal on request");
}
