import type { FastifyReply, FastifyRequest } from "fastify";

/** Requires deployment-operator authority; authentication alone is not enough. */
export function refuseNonOperator(req: FastifyRequest, reply: FastifyReply): boolean {
  const caller = req.principal;
  if (caller === undefined) {
    reply.code(401).send({ error: "unauthorized" });
    return true;
  }
  if (caller.kind !== "user" || caller.role !== "admin") {
    reply.code(403).send({ error: "forbidden" });
    return true;
  }
  return false;
}
