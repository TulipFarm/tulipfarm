import type { ChatIngressConfig } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import type { ToolRegistry } from "../tools/registry";
import { executeToolBinding, extractFromToolResult } from "./bindings";

/**
 * Resolves an inbound sender to the TulipFarm user the turn runs as, using the manifest's
 * declarative identity binding: execute the bound tool (var: {sender}) through the
 * integration's own MCP tools, extract `email_path` from the result, match by email, and fall
 * back to the first admin (approved product decision — V1 instances are effectively
 * single-admin). No binding declared → straight to the admin fallback. Resolutions are cached
 * per boot, keyed by integration slug + sender id.
 */
export class IngressIdentityResolver {
  private readonly cache = new Map<string, UserDoc | null>();

  constructor(
    private readonly users: IngressUserLookup,
    private readonly log: FastifyBaseLogger
  ) {}

  /** Resolve the sender, falling back to the first admin. Null only when no admin exists. */
  async resolve(opts: {
    slug: string;
    sender: string;
    identity?: ChatIngressConfig["identity"];
    registry?: ToolRegistry;
  }): Promise<UserDoc | null> {
    const { slug, sender, identity, registry } = opts;
    if (!identity || !registry) return this.users.findFirstAdmin();

    const cacheKey = `${slug}:${sender}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached ?? this.users.findFirstAdmin();

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
          "ingress identity binding failed; using admin fallback"
        );
      }
    } catch (err) {
      this.log.warn({ err, slug, sender }, "ingress identity binding threw; using admin fallback");
    }
    this.cache.set(cacheKey, matched);
    return matched ?? this.users.findFirstAdmin();
  }
}
