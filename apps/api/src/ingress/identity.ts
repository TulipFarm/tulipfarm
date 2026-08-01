import { PrincipalDeniedError } from "@tulipfarm/authz";
import type { ChatIngressConfig } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import type { ToolRegistry } from "../broker/tool-adapter";
import {
  type ChannelBindDeps,
  type IssuedChannelBind,
  issueChannelBindToken,
} from "../identity/channel-link";
import {
  ExternalIdentityDeniedError,
  type ExternalIdentityRepo,
  resolveExternalIdentity,
} from "../identity/external-links";
import { assertUserAuthenticatable } from "../identity/principal";
import { executeToolBinding, extractFromToolResult } from "./bindings";

/**
 * Resolves an inbound channel sender to the TulipFarm user the turn runs as.
 *
 * A channel sender is an external identity like any other, so the authority is
 * `external_identity_mappings` and the check is `assertExternalIdentityMapped` (SPEC §12) — there is
 * no channel-specific table and no channel-specific rule. What is channel-specific is how a mapping
 * first comes to exist, and that is the whole of this class:
 *
 *  1. **An existing mapping wins.** Verified once, honoured thereafter.
 *  2. **The manifest identity binding.** Execute the bound tool, read `email_path`, and if it names
 *     a known account, persist the mapping. Persisting is the point: the previous per-boot cache
 *     re-derived identity on every restart, so the same sender's authority depended on how recently
 *     the process had started, and nothing about the binding was auditable afterwards.
 *  3. **Neither.** The sender is unlinked. The agent is *not* invoked — an unknown sender is never
 *     silently answered as somebody, least of all as an administrator — and a single-use bind link
 *     is offered so the person behind the sender can claim it inside their own session.
 */
export type ChannelSenderResolution =
  | { outcome: "linked"; user: UserDoc }
  | { outcome: "unlinked"; bindOffer: IssuedChannelBind | null };

export interface ChannelIdentityDeps {
  users: IngressUserLookup;
  log: FastifyBaseLogger;
  /** Authority for "this sender is this user". Absent → every sender is unlinked. */
  mappings?: ExternalIdentityRepo;
  /** Issues the bind link offered to an unlinked sender. Absent → deny without offering one. */
  bind?: ChannelBindDeps;
  now?: () => Date;
}

export class IngressIdentityResolver {
  constructor(private readonly deps: ChannelIdentityDeps) {}

  async resolve(opts: {
    slug: string;
    sender: string;
    identity?: ChatIngressConfig["identity"];
    registry?: ToolRegistry;
  }): Promise<ChannelSenderResolution> {
    const linked = await this.findLinkedUser(opts.slug, opts.sender);
    if (linked) return { outcome: "linked", user: linked };

    const claimed = await this.claimByManifestEmail(opts);
    if (claimed) return { outcome: "linked", user: claimed };

    return { outcome: "unlinked", bindOffer: await this.offerBind(opts.slug, opts.sender) };
  }

  /** Step 1 — an existing verified mapping, checked by the same guard every other subject faces. */
  private async findLinkedUser(slug: string, sender: string): Promise<UserDoc | null> {
    const mappings = this.deps.mappings;
    if (!mappings) return null;

    const now = (this.deps.now ?? (() => new Date()))();
    let userId: string;
    try {
      userId = await resolveExternalIdentity(mappings, slug, sender, now);
    } catch (err) {
      if (err instanceof ExternalIdentityDeniedError) return null;
      throw err;
    }

    const user = await this.deps.users.findById(userId);
    if (!user) {
      // The account was deleted out from under the mapping. Falling through re-derives the link
      // from the manifest rather than acting for a user who no longer exists.
      this.deps.log.warn({ slug, sender }, "channel mapping names a user that no longer exists");
      return null;
    }
    try {
      assertUserAuthenticatable(user, now);
    } catch (err) {
      if (err instanceof PrincipalDeniedError) {
        // Suspended or expired. A channel must not become a way around that.
        this.deps.log.warn({ slug, sender }, "channel sender maps to a user who may not act");
        return null;
      }
      throw err;
    }
    return user;
  }

  /** Step 2 — the manifest's declarative identity binding, persisted when it names a known account. */
  private async claimByManifestEmail(opts: {
    slug: string;
    sender: string;
    identity?: ChatIngressConfig["identity"];
    registry?: ToolRegistry;
  }): Promise<UserDoc | null> {
    const { slug, sender, identity, registry } = opts;
    if (!identity || !registry) return null;

    let matched: UserDoc | null = null;
    try {
      const result = await executeToolBinding(registry, slug, identity, { sender });
      if (result.success) {
        const email = extractFromToolResult(result.data, identity.email_path);
        if (typeof email === "string" && email) {
          matched = await this.deps.users.findByEmail(email);
        }
      } else {
        this.deps.log.warn(
          { slug, sender, error: result.error },
          "ingress identity binding failed; denying external actor"
        );
      }
    } catch (err) {
      this.deps.log.warn(
        { err, slug, sender },
        "ingress identity binding threw; denying external actor"
      );
    }
    if (!matched) return null;

    const now = (this.deps.now ?? (() => new Date()))();
    try {
      assertUserAuthenticatable(matched, now);
    } catch (err) {
      if (err instanceof PrincipalDeniedError) return null;
      throw err;
    }

    await this.deps.mappings?.upsertMapping({
      provider: slug,
      externalSubject: sender,
      userId: matched._id,
      verifiedAt: now,
      expiresAt: null,
      verifiedVia: "manifest_email",
    });
    return matched;
  }

  /** Step 3 — what an unlinked sender is given instead of an answer. */
  private async offerBind(slug: string, sender: string): Promise<IssuedChannelBind | null> {
    if (!this.deps.bind) return null;
    try {
      return await issueChannelBindToken(this.deps.bind, { slug, senderId: sender });
    } catch (err) {
      // The denial stands either way; failing to offer a way out must not turn into a failed turn.
      this.deps.log.warn({ err, slug, sender }, "could not issue a channel bind link");
      return null;
    }
  }
}
