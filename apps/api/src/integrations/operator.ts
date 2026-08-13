import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Refuses a caller who is not a deployment operator.
 *
 * `requireAuth` is authentication only. Every route that reaches for this writes some part of the
 * **deployment-wide** provider connection — the credential every unattended Run and every
 * service-mode Tool spends, or the mapping that says which repository this business's Soul lives
 * in. Left on authentication alone they are all a way around the same refusal
 * `integrations/auth-routes.ts` makes for `scope: "business"`: a member who cannot complete a
 * business auth step could seal the provider's client id and secret through another door instead,
 * re-pointing the deployment's OAuth flow at an app they control. Disconnect, remove and
 * repointing the Soul repo are the same authority aimed the other way — revoking or redirecting
 * every Agent's reach in one call.
 *
 * It lives here rather than inside one route module because the authority is a property of the
 * *act*, not of the file: the first version of this gate covered `integrations/routes.ts` and left
 * `github-install-routes.ts` — which repoints the Soul repository, the source of truth every other
 * layer is checked against — open. A shared helper makes adding the fourth door harder to forget
 * than adding the fourth copy.
 *
 * Personal credentials are deliberately unaffected: `scope: "user"` on the auth-step route stays
 * self-service, because a credential bounded by what the provider already grants that person needs
 * no operator, and requiring one would push every Tool back onto the shared bot — the attribution
 * collapse personal credentials exist to end.
 *
 * Returns `true` when it has already answered the request, so a handler's first line reads
 * `if (refuseNonOperator(req, reply)) return;`.
 */
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
