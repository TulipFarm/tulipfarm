import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';
import { knowledgeEmbeddingProfile, type KnowledgeEmbeddingsConfig } from '@tulipfarm/config';

const tokenizer = getEncoding('cl100k_base');
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageEnvelope = z.object({ usage: z.object({ prompt_tokens: tokenCount, total_tokens: tokenCount }) });

export type KnowledgeEmbeddingError =
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
export type KnowledgeEmbeddingUsage =
  | { kind: 'known'; inputTokens: number; totalTokens: number; exceedsUpperBound: boolean }
  | { kind: 'unknown'; reason: 'undispatched' | 'missing' | 'invalid' | 'transport' | 'timeout' | 'cancelled' };
export type KnowledgeEmbeddingResult = {
  dispatch: 'dispatched' | 'undispatched';
  inputTokensUpperBound: number;
  requestId: string | null;
  usage: KnowledgeEmbeddingUsage;
  result: { kind: 'success'; vectors: number[][]; model: string } | { kind: 'error'; code: KnowledgeEmbeddingError };
};
export type KnowledgeEmbeddingProvider = (input: {
  inputs: readonly string[];
  signal?: AbortSignal;
}) => Promise<KnowledgeEmbeddingResult>;

export function prepareKnowledgeEmbeddingInputs(inputs: readonly string[]) {
  const profile = knowledgeEmbeddingProfile;
  const parsed = z.array(z.string().min(1)).min(1).max(profile.maxBatchInputs).safeParse(inputs);
  if (!parsed.success) throw new Error('Invalid knowledge embedding input');
  let inputTokensUpperBound = 0;
  for (const text of parsed.data) {
    if (!text.trim() || /[\uD800-\uDFFF]/u.test(text) || Buffer.byteLength(text, 'utf8') > profile.maxInputBytes)
      throw new Error('Invalid knowledge embedding input');
    const tokens = tokenizer.encode(text, [], []).length;
    if (tokens > profile.maxInputTokens) throw new Error('Invalid knowledge embedding input');
    inputTokensUpperBound += tokens;
  }
  if (inputTokensUpperBound > profile.maxBatchTokens) throw new Error('Invalid knowledge embedding input');
  return Object.freeze({
    inputs: Object.freeze(parsed.data),
    inputTokensUpperBound,
    inputHash: createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'),
  });
}

function responseRequestId(headers: Headers): string | null {
  const value = headers.get('apim-request-id') ?? headers.get('x-request-id');
  return value && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : null;
}

function observeUsage(body: unknown, bound: number): KnowledgeEmbeddingUsage {
  const parsed = usageEnvelope.safeParse(body);
  if (!parsed.success) {
    const envelope = z.object({ usage: z.unknown() }).safeParse(body);
    return { kind: 'unknown', reason: envelope.success && envelope.data.usage !== undefined ? 'invalid' : 'missing' };
  }
  const usage = parsed.data.usage;
  if (usage.prompt_tokens !== usage.total_tokens) return { kind: 'unknown', reason: 'invalid' };
  return {
    kind: 'known',
    inputTokens: usage.prompt_tokens,
    totalTokens: usage.total_tokens,
    exceedsUpperBound: usage.prompt_tokens > bound,
  };
}

function validateResult(body: unknown, count: number): KnowledgeEmbeddingResult['result'] {
  const model = z.object({ model: z.literal(knowledgeEmbeddingProfile.model) }).safeParse(body);
  if (!model.success) return { kind: 'error', code: 'invalid_model' };
  const parsed = z
    .object({
      data: z
        .array(
          z.object({
            index: z
              .number()
              .int()
              .nonnegative()
              .max(count - 1),
            embedding: z.array(z.number().finite()).length(knowledgeEmbeddingProfile.dimensions),
          }),
        )
        .length(count),
    })
    .safeParse(body);
  if (!parsed.success || new Set(parsed.data.data.map(row => row.index)).size !== count)
    return { kind: 'error', code: 'invalid_vectors' };
  return {
    kind: 'success',
    model: model.data.model,
    vectors: parsed.data.data.sort((a, b) => a.index - b.index).map(row => row.embedding),
  };
}

/** Calls Azure Foundry or any OpenAI-compatible `/embeddings` endpoint selected by `config.provider`. */
export function createKnowledgeEmbeddingProvider(
  config: KnowledgeEmbeddingsConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): KnowledgeEmbeddingProvider {
  const fetchRequest = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error('Invalid knowledge embedding timeout');
  return async ({ inputs, signal }) => {
    const undispatched = (code: KnowledgeEmbeddingError): KnowledgeEmbeddingResult => ({
      dispatch: 'undispatched',
      inputTokensUpperBound: 0,
      requestId: null,
      usage: { kind: 'unknown', reason: 'undispatched' },
      result: { kind: 'error', code },
    });
    if (config.kind === 'disabled') return undispatched('disabled');
    if (signal?.aborted) return undispatched('cancelled');
    let prepared: ReturnType<typeof prepareKnowledgeEmbeddingInputs>;
    try {
      prepared = prepareKnowledgeEmbeddingInputs(inputs);
    } catch {
      return undispatched('invalid_input');
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let requestId: string | null = null;
    const base = { dispatch: 'dispatched' as const, inputTokensUpperBound: prepared.inputTokensUpperBound };
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Embedding request aborted')), {
          once: true,
        });
      });
      const azure = config.provider === 'azure-foundry';
      const response = await Promise.race([
        fetchRequest(`${config.endpoint}${azure ? 'openai/v1/' : ''}embeddings`, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            ...(azure ? { 'api-key': config.apiKey } : { authorization: `Bearer ${config.apiKey}` }),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.requestModel,
            input: prepared.inputs,
            dimensions: config.profile.dimensions,
            encoding_format: 'float',
          }),
        }),
        aborted,
      ]);
      requestId = responseRequestId(response.headers);
      let body: unknown;
      try {
        body = await Promise.race([response.json(), aborted]);
      } catch {
        if (controller.signal.aborted) throw new Error('Embedding request aborted');
        return {
          ...base,
          requestId,
          usage: { kind: 'unknown', reason: 'invalid' },
          result: { kind: 'error', code: response.ok ? 'invalid_json' : 'http' },
        };
      }
      const usage = observeUsage(body, prepared.inputTokensUpperBound);
      const result = !response.ok
        ? { kind: 'error' as const, code: 'http' as const }
        : usage.kind === 'unknown'
          ? { kind: 'error' as const, code: 'invalid_usage' as const }
          : usage.exceedsUpperBound
            ? { kind: 'error' as const, code: 'usage_exceeds_bound' as const }
            : validateResult(body, prepared.inputs.length);
      return { ...base, requestId, usage, result };
    } catch {
      const reason = timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'transport';
      return { ...base, requestId, usage: { kind: 'unknown', reason }, result: { kind: 'error', code: reason } };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  };
}
