import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { stringify } from "yaml";
import type { CommitActor } from "../commit-signing";
import type { SoulWriteRequest } from "../writer";

/** An Agent's `AGENT.md` text: a frontmatter block when there is any, then the markdown body. */
export function serializeAgent(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${stringify(frontmatter)}---\n${body}`;
}

/**
 * The `AGENT.md` changeset for a create or an update. Only `add` asserts the slug is free — an
 * update carrying that precondition could never apply to the Agent it is meant to replace.
 */
export function agentWriteRequest(
  verb: "add" | "update",
  name: string,
  frontmatter: Record<string, unknown>,
  body: string,
  actor: CommitActor
): SoulWriteRequest {
  return {
    subject: `soul: ${verb} agent ${name}`,
    source: "agent",
    actor,
    businessId: DEPLOYMENT_BUSINESS_ID,
    changes: [
      {
        op: "put",
        target: { kind: "Agent", slug: name, definitionMode: "legacy" },
        content: serializeAgent(frontmatter, body),
      },
    ],
    ...(verb === "add"
      ? { preconditions: [{ kind: "Agent" as const, slug: name, state: "absent" as const }] }
      : {}),
  };
}
