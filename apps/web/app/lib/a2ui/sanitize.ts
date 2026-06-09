import DOMPurify from "dompurify";

/**
 * Sanitize untrusted, agent-emitted HTML before it is injected into the A2UI iframe srcdoc.
 *
 * This is defense-in-depth behind the iframe sandbox + CSP: even though the sandbox isolates the
 * document and the CSP blocks scripts/network, we still strip all active content from the agent's
 * markup. `tf-*` custom elements (and their data-/aria- config attributes) are explicitly allowed
 * through so the future component runtime can hydrate them; everything executable is removed.
 */

const TF_TAG = /^tf-[a-z][a-z0-9-]*$/;
const TF_ATTR = /^(?:data-|aria-)[a-z0-9-]+$/;

export function sanitizeAgentHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // Untrusted inline styles are an unneeded surface; tf-* components carry their own styling.
    FORBID_ATTR: ["style"],
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: TF_TAG,
      attributeNameCheck: TF_ATTR,
      allowCustomizedBuiltInElements: false,
    },
  });
}
