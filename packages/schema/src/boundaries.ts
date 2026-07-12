export const BOUNDARIES = [
  "soul",
  "resource",
  "api",
  "agent",
  "llm",
  "event",
  "integration",
] as const;

export type ValidationBoundary = (typeof BOUNDARIES)[number];
