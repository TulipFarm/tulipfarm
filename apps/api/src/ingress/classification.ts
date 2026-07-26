/** Validated output from an Integration's isolated ingress classifier. */
export type IngressDecision =
  | { kind: "ignore"; reason?: string }
  | {
      kind: "chat";
      sender: string;
      text: string;
      requireExistingThread?: boolean;
      reply: { binding: string; vars?: Record<string, string> };
    }
  | { kind: "event"; eventType: string; payload?: Record<string, unknown> };

/** Reject malformed classifier output before it can create a Run or influence authority. */
export function parseDecision(raw: unknown): IngressDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const decision = raw as Record<string, unknown>;
  if (decision.kind === "ignore") {
    return {
      kind: "ignore",
      reason: typeof decision.reason === "string" ? decision.reason : undefined,
    };
  }
  if (decision.kind === "event") {
    if (typeof decision.eventType !== "string" || decision.eventType.length === 0) return null;
    const payload =
      decision.payload && typeof decision.payload === "object" && !Array.isArray(decision.payload)
        ? (decision.payload as Record<string, unknown>)
        : undefined;
    return { kind: "event", eventType: decision.eventType, payload };
  }
  if (decision.kind !== "chat") return null;
  if (typeof decision.sender !== "string" || decision.sender.length === 0) return null;
  if (typeof decision.text !== "string") return null;
  const reply = decision.reply as Record<string, unknown> | undefined;
  if (!reply || typeof reply !== "object" || typeof reply.binding !== "string") return null;
  let vars: Record<string, string> | undefined;
  if (reply.vars && typeof reply.vars === "object" && !Array.isArray(reply.vars)) {
    vars = {};
    for (const [key, value] of Object.entries(reply.vars as Record<string, unknown>)) {
      if (typeof value === "string") vars[key] = value;
    }
  }
  return {
    kind: "chat",
    sender: decision.sender,
    text: decision.text,
    requireExistingThread: decision.requireExistingThread === true,
    reply: { binding: reply.binding, vars },
  };
}
