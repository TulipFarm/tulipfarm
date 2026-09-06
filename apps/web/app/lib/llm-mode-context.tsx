import { createContext, type ReactNode, useContext } from "react";

/**
 * Which settings tab the model config was last saved from, published once at the app shell so
 * chat surfaces can hide effort controls that mean nothing in Basic (one model, all three tiers)
 * without threading it through every intermediate component. Comes from the session response
 * (`SessionUser.llmMode`), which `_app.tsx`'s `clientLoader` already fetches on every page load —
 * defaults to `"basic"` so an absent value (older API build, or no soul yet) fails toward hiding
 * the more advanced controls rather than showing ones a Basic-only setup can't back.
 */
const LlmModeContext = createContext<"basic" | "advanced">("basic");

export function LlmModeProvider({
  mode,
  children,
}: {
  readonly mode: "basic" | "advanced" | undefined;
  readonly children: ReactNode;
}) {
  return <LlmModeContext.Provider value={mode ?? "basic"}>{children}</LlmModeContext.Provider>;
}

export function useLlmMode(): "basic" | "advanced" {
  return useContext(LlmModeContext);
}
