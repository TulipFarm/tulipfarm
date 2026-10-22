export type EmbeddingProfile = Readonly<{
  id: string;
  model: string;
  dimensions: number;
  maxInputTokens: number;
  maxBatchInputs: number;
  maxBatchTokens: number;
  maxInputBytes: number;
}>;

export type EmbeddingError =
  | 'disabled'
  | 'invalid_input'
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'http'
  | 'invalid_json'
  | 'invalid_usage'
  | 'invalid_model'
  | 'invalid_vectors'
  | 'usage_exceeds_bound';
export type EmbeddingUsage =
  | { kind: 'known'; inputTokens: number; totalTokens: number; exceedsUpperBound: boolean }
  | { kind: 'unknown'; reason: 'undispatched' | 'missing' | 'invalid' | 'transport' | 'timeout' | 'cancelled' };
export type EmbeddingResult = {
  dispatch: 'dispatched' | 'undispatched';
  inputTokensUpperBound: number;
  requestId: string | null;
  usage: EmbeddingUsage;
  result: { kind: 'success'; vectors: number[][]; model: string } | { kind: 'error'; code: EmbeddingError };
};
export type EmbeddingProvider = (input: {
  inputs: readonly string[];
  signal?: AbortSignal;
}) => Promise<EmbeddingResult>;

export type EmbeddingProviderConfig =
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'enabled';
      readonly provider: 'azure-foundry' | 'openai-compatible';
      readonly endpoint: string;
      readonly apiKey: string;
      readonly requestModel: string;
      readonly profile: EmbeddingProfile;
    };
