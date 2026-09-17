import type { IngressReplyResult } from "@tulipfarm/schema";
import type { ChatIngressConfig } from "@tulipfarm/soul";
import { isParked } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../broker/tool-adapter";
import { executeReplyBinding, type IngressRunContext } from "./bindings";

type ResponderLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** Only confirmed provider effects are delivered; retry waits retain their durable identity. */
export async function postReply(
  deps: { registry?: ToolRegistry; log: ResponderLogger },
  opts: {
    slug: string;
    reply: ChatIngressConfig["reply"];
    binding: string;
    vars: Record<string, string>;
    text: string;
    run: IngressRunContext;
  }
): Promise<IngressReplyResult> {
  const binding = opts.reply[opts.binding] ?? opts.reply.default;
  if (!binding) {
    deps.log.error(
      { slug: opts.slug, binding: opts.binding },
      "ingress reply binding not declared in manifest; reply dropped"
    );
    return { delivered: false, outcome: "failed", code: "reply_binding_missing" };
  }
  if (!deps.registry) {
    deps.log.error({ slug: opts.slug }, "ingress reply needs the tool registry; reply dropped");
    return { delivered: false, outcome: "retryable", code: "reply_registry_unavailable" };
  }
  try {
    const result = await executeReplyBinding(
      deps.registry,
      opts.slug,
      binding,
      { ...opts.vars, text: opts.text },
      opts.run
    );
    if (isParked(result)) {
      return result.parked.kind === "retry_wait"
        ? {
            delivered: false,
            outcome: "retryable",
            code: "provider_retry_wait",
            waitId: result.parked.waitId,
          }
        : { delivered: false, outcome: "ambiguous", code: "unexpected_reply_park" };
    }
    if (!result.success) {
      deps.log.error(
        { slug: opts.slug, tool: binding.tool, error: result.error },
        "ingress reply delivery failed"
      );
      return {
        delivered: false,
        outcome:
          result.error.code === "indeterminate"
            ? "ambiguous"
            : result.error.code === "unavailable"
              ? "retryable"
              : "failed",
        code: result.error.code,
      };
    }
    return { delivered: true };
  } catch (err) {
    deps.log.error({ slug: opts.slug, tool: binding.tool, err }, "ingress reply delivery threw");
    return { delivered: false, outcome: "ambiguous", code: "reply_outcome_unknown" };
  }
}
