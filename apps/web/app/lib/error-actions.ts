// Maps an actionable error message to a CTA (label + in-app route) so error surfaces (chat, etc.)
// can deep-link the user straight to where they fix it. Returns null for errors with no specific
// action. Matching is substring-based on the API's error message, case-insensitive — add a new
// branch here when an error becomes self-serviceable from a settings page.
export type ErrorAction = { label: string; to: string };

export function errorAction(message: string | null | undefined): ErrorAction | null {
  if (!message) return null;
  const m = message.toLowerCase();

  // LlmNotConfiguredError ("LLM not configured") / UnknownModelError ("model not configured ...").
  if (m.includes("not configured")) {
    return { label: "Configure models", to: "/business/models" };
  }
  if (m.includes("configured model is unavailable") || m.includes("modelprofile")) {
    return { label: "Configure models", to: "/business/models" };
  }
  // LlmCredentialError — a stored provider key is missing or can't be decrypted.
  if (m.includes("credential") || m.includes("/secrets/") || m.includes("api key")) {
    return { label: "Manage secrets", to: "/business/secrets" };
  }
  return null;
}
