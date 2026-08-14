import { randomUUID } from "node:crypto";
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

/** Resolves channel senders; unknown senders never invoke an Agent. */
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

  /** Step 2 — persist the manifest identity binding when it names a known account. */
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
      // A fresh toolCallId every time, unlike a reply: the Effect store replays a duplicate
      // reservation, so a stable id here would answer every future lookup with the email this
      // sender had the first time they spoke — surviving any later change on the provider side.
      const result = await executeToolBinding(
        registry,
        slug,
        identity,
        { sender },
        { runId: `ingress-identity:${slug}`, toolCallId: randomUUID() }
      );
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
