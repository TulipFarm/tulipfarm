import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import type { SlackClient } from "./slack-client";

/**
 * Resolves an inbound Slack sender to the TulipFarm user the turn runs as:
 * slack user id → users.info email → UserRepo email match → admin fallback (approved product
 * decision — V1 instances are effectively single-admin). Resolutions are cached per boot; the
 * Slack-side mapping of a user id to an email is stable enough that a restart-scoped cache
 * never needs invalidation.
 */
export class SlackIdentityResolver {
  private readonly cache = new Map<string, UserDoc | null>();

  constructor(
    private readonly users: IngressUserLookup,
    private readonly log: FastifyBaseLogger
  ) {}

  /** Resolve the sender, falling back to the first admin. Null only when no admin exists. */
  async resolve(client: SlackClient, slackUserId: string): Promise<UserDoc | null> {
    const cached = this.cache.get(slackUserId);
    if (cached !== undefined) return cached ?? this.users.findFirstAdmin();

    let matched: UserDoc | null = null;
    try {
      const email = await client.userEmail(slackUserId);
      if (email) matched = await this.users.findByEmail(email);
    } catch (err) {
      // Slack API hiccup (or missing users:read.email) — fall through to the admin fallback.
      this.log.warn({ err, slackUserId }, "slack users.info lookup failed; using admin fallback");
    }
    this.cache.set(slackUserId, matched);
    return matched ?? this.users.findFirstAdmin();
  }
}
