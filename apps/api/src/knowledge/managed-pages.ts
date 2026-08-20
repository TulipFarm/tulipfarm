/**
 * Pages the Knowledge CRUD surface may not write.
 *
 * A File indexed into Knowledge becomes an ordinary authored Page whose ACL grants read to the
 * File's owner *and every sharee*. That is what makes retrieval work for a shared File, but it
 * collides with the two subsystems' opposite readership contracts: Knowledge is a wiki, where
 * "anyone who can read it can reshare it", while the Files domain promises that sharing conveys
 * reading alone and a recipient can neither re-share nor revoke.
 *
 * Left alone, the wiki policy wins and the File policy is a lie — a read-only recipient could
 * clear the Page's restriction and publish a private document to the whole Business, rewrite the
 * indexed text so agents cite the owner's filename over the recipient's words, or move the Page
 * somewhere its readership is decided by different rules.
 *
 * So a File's Page is writable only through the File. The Files routes and the indexing job call
 * the service directly and are unaffected; this closes the HTTP surface, which is the only one an
 * attacker holds.
 */

import type { KnowledgeService } from "@tulipfarm/knowledge";
import type { FastifyReply } from "fastify";

/**
 * Refuses a write to a Page that a File owns, having already established the caller may read it.
 *
 * Call *after* the read gate, never before: refusing ahead of it would confirm to a stranger that
 * a Page exists. Past the read gate the caller can already see the Page, so naming the reason
 * discloses nothing and is the only way they learn where the readership is actually managed.
 *
 * @returns `true` when it has answered the request and the handler must stop.
 */
export async function refusedAsFileManaged(
  service: Pick<KnowledgeService, "getPage">,
  pageId: string,
  reply: FastifyReply
): Promise<boolean> {
  const page = await service.getPage(pageId);
  if (page?.source !== "file") return false;
  reply.code(409).send({
    error:
      "this page is a File in the library: its content and its readership are managed on the " +
      "File, not here",
  });
  return true;
}
