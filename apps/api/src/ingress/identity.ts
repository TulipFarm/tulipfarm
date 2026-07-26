import type { ChatIngressConfig } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import type { ToolRegistry } from "../broker/tool-adapter";
import { executeToolBinding, extractFromToolResult } from "./bindings";

/**
 * Resolves an inbound sender to the TulipFarm user the turn runs as, using the manifest's
 * declarative identity binding: execute the bound tool (var: {sender}) through the
 * integration's own MCP tools, extract `email_path` from the result, and match by email.
 * Unmapped, failed, or undeclared bindings deny; an external actor is never substituted with an
 * administrator. Resolutions are cached per boot, keyed by integration slug + sender id.
 */
export class IngressIdentityResolver {
  private readonly cache = new Map<string, UserDoc | null>();

  constructor(
    private readonly users: IngressUserLookup,
    private readonly log: FastifyBaseLogger
  ) {}

  /** Resolve the sender exactly. Null means the external actor is not mapped and must be denied. */
  async resolve(opts: {
    slug: string;
    sender: string;
    identity?: ChatIngressConfig["identity"];
    registry?: ToolRegistry;
  }): Promise<UserDoc | null> {
    const { slug, sender, identity, registry } = opts;
    if (!identity || !registry) return null;

    const cacheKey = `${slug}:${sender}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let matched: UserDoc | null = null;
    try {
      const result = await executeToolBinding(registry, slug, identity, { sender });
      if (result.success) {
        const email = extractFromToolResult(result.data, identity.email_path);
        if (typeof email === "string" && email) {
          matched = await this.users.findByEmail(email);
        }
      } else {
        this.log.warn(
          { slug, sender, error: result.error },
          "ingress identity binding failed; denying external actor"
        );
      }
    } catch (err) {
      this.log.warn(
        { err, slug, sender },
        "ingress identity binding threw; denying external actor"
      );
    }
    this.cache.set(cacheKey, matched);
    return matched;
  }
}
