export const BOUNDARIES = [
  "soul",
  "resource",
  "api",
  "agent",
  "llm",
  "event",
  "integration",
  "deployment",
] as const;

export type ValidationBoundary = (typeof BOUNDARIES)[number];
