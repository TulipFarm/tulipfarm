export type ChatMessage = { role: 'user' | 'assistant'; text: string };
export type ContextMessage = ChatMessage & { id: string; acceptedSequence: number };
export type EffectiveCompactionPolicy = {
  automatic: boolean;
  triggerPercent: number;
  targetPercent: number;
  outputPrompt: string | null;
  revision: number;
  families: string[];
};
export type ContextMeasure = { tokens: number; window: number };
/** `tool-results` summarises older tool results inside one reply; its steps are the reply's model rounds. */
export type CompactionPurpose = 'summary' | 'handoff' | 'memory' | 'tool-results';

export type Summarizer<PolicyContext, Fence, ReplyFence = Fence> = {
  policy(context: PolicyContext): Promise<EffectiveCompactionPolicy>;
  /** Estimated input tokens for the chat responder's first request, or null when the turn model cannot be measured. */
  measure(input: {
    fence: ReplyFence;
    model: string;
    messages: readonly ChatMessage[];
    project?: unknown;
    generateTitle: boolean;
    timeZone: string | null;
  }): Promise<ContextMeasure | null>;
  /** Smallest input byte budget among the given summary families. */
  window(families: readonly string[]): Promise<number>;
  summarize(input: {
    fence: Fence;
    purpose: CompactionPurpose;
    step: number;
    system: string;
    messages: readonly ChatMessage[];
    families: readonly string[];
  }): Promise<{ text: string; familyId: string; fallbackFrom: string | null }>;
};
