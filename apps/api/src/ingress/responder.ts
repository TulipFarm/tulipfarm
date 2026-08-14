import type { ChatIngressConfig } from "@tulipfarm/soul";
import type { ToolRegistry } from "../broker/tool-adapter";
import { executeToolBinding, type IngressRunContext } from "./bindings";

type ResponderLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** Sends replies through the manifest reply binding with `{text}` injected; failures only log. */
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
): Promise<void> {
  const binding = opts.reply[opts.binding] ?? opts.reply.default;
  if (!binding) {
    deps.log.error(
      { slug: opts.slug, binding: opts.binding },
      "ingress reply binding not declared in manifest; reply dropped"
    );
    return;
  }
  if (!deps.registry) {
    deps.log.error({ slug: opts.slug }, "ingress reply needs the tool registry; reply dropped");
    return;
  }
  try {
    const result = await executeToolBinding(
      deps.registry,
      opts.slug,
      binding,
      { ...opts.vars, text: opts.text },
      opts.run
    );
    if (!result.success) {
      deps.log.error(
        { slug: opts.slug, tool: binding.tool, error: result.error },
        "ingress reply delivery failed"
      );
    }
  } catch (err) {
    deps.log.error({ slug: opts.slug, tool: binding.tool, err }, "ingress reply delivery threw");
  }
}
