import { PrincipalDeniedError } from "@tulipfarm/authz";
import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import {
  type ChannelBindDeps,
  type IssuedChannelBind,
  issueChannelBindToken,
} from "../identity/channel-link";
import {
  ExternalIdentityDeniedError,
  type ExternalIdentityRepo,
  type IdentityVerificationMethod,
  isProvenLink,
  resolveExternalSender,
} from "../identity/external-links";
import { assertUserAuthenticatable } from "../identity/principal";

/** Resolves channel senders; unknown senders never invoke an Agent. */
export type ChannelSenderResolution =
  | LinkedChannelSender
  | { outcome: "unlinked"; bindOffer: IssuedChannelBind | null };

/**
 * A sender we can place, plus the authority that placement earns.
 *
 * Identifying a sender and empowering them are separate questions. A provider-asserted email match
 * answers the first — it is enough to route the message to the right conversation — but not the
 * second: on Slack Connect the counterparty organisation administers its own users' addresses, so
 * it can assert any address it likes, including one of ours. Such a sender therefore resolves to a
 * *guest* principal, which appears in no Surface audience, no approval allowlist and no Knowledge
 * ACL, and so can spend nothing belonging to the account it matched.
 */
export interface LinkedChannelSender {
  readonly outcome: "linked";
  /** Who the sender was matched to. Routing only — never treat this as authority. */
  readonly user: UserDoc;
  /** `user` once the link was proven; `guest` while only the provider vouches for it. */
  readonly principalKind: "user" | "guest";
  /** Bare principal id, for allowlists that hold unprefixed ids. */
  readonly principalId: string;
  /** `kind:id`, for allowlists and grants that hold prefixed refs. */
  readonly principalRef: string;
}

/** Verification strong enough to act *as* the matched user, not merely be routed to them. */
function senderAuthority(
  user: UserDoc,
  provider: string,
  sender: string,
  externalTenantId: string | undefined,
  verifiedVia: IdentityVerificationMethod | undefined
): LinkedChannelSender {
  const proven = isProvenLink({ verifiedVia: verifiedVia ?? null });
  const principalKind = proven ? "user" : "guest";
  const principalId = proven
    ? user._id
    : [provider, externalTenantId, sender].filter((part) => part !== undefined).join(":");
  return {
    outcome: "linked",
    user,
    principalKind,
    principalId,
    principalRef: `${principalKind}:${principalId}`,
  };
}

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
    externalTenantId?: string;
    /** Where the sender messaged from, so a bind offer can be replied to once confirmed. */
    channelId?: string;
    threadId?: string;
  }): Promise<ChannelSenderResolution> {
    const linked = await this.findLinkedUser(opts.slug, opts.sender, opts.externalTenantId);
    if (linked) {
      return senderAuthority(
        linked.user,
        opts.slug,
        opts.sender,
        opts.externalTenantId,
        linked.verifiedVia
      );
    }

    return {
      outcome: "unlinked",
      bindOffer: await this.offerBind(
        opts.slug,
        opts.sender,
        opts.externalTenantId,
        opts.channelId,
        opts.threadId
      ),
    };
  }

  /** Step 1 — an existing verified mapping, checked by the same guard every other subject faces. */
  private async findLinkedUser(
    slug: string,
    sender: string,
    externalTenantId?: string
  ): Promise<{ user: UserDoc; verifiedVia?: IdentityVerificationMethod } | null> {
    const mappings = this.deps.mappings;
    if (!mappings) return null;

    const now = (this.deps.now ?? (() => new Date()))();
    let resolved: { userId: string; verifiedVia?: IdentityVerificationMethod };
    try {
      resolved = await resolveExternalSender(mappings, slug, sender, now, externalTenantId);
    } catch (err) {
      if (err instanceof ExternalIdentityDeniedError) return null;
      throw err;
    }

    const user = await this.deps.users.findById(resolved.userId);
    if (!user) {
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
    return { user, ...(resolved.verifiedVia ? { verifiedVia: resolved.verifiedVia } : {}) };
  }

  private async offerBind(
    slug: string,
    sender: string,
    externalTenantId?: string,
    channelId?: string,
    threadId?: string
  ): Promise<IssuedChannelBind | null> {
    if (!this.deps.bind) return null;
    try {
      return await issueChannelBindToken(this.deps.bind, {
        slug,
        senderId: sender,
        ...(externalTenantId === undefined ? {} : { externalTenantId }),
        ...(channelId === undefined ? {} : { channelId }),
        ...(threadId === undefined ? {} : { threadId }),
      });
    } catch (err) {
      // The denial stands either way; failing to offer a way out must not turn into a failed turn.
      this.deps.log.warn({ err, slug, sender }, "could not issue a channel bind link");
      return null;
    }
  }
}
