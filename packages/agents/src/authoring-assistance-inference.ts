import { z } from 'zod';
import { observeInference } from '@tulipfarm/observability';
import {
  inferenceRouteSchema,
  openAiWire,
  routeCapabilities,
  type InferenceRoute,
  type InferenceUsage,
} from './inference.ts';
import { agentAuthoringLimits, AgentAuthoringError } from './authoring-assistance-contracts.ts';

type Message = { role: 'user' | 'assistant'; content: string };
type Route = z.output<typeof inferenceRouteSchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const empty = {
  kind: 'known',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
} as const;
const unknown = { kind: 'unknown' } as const;
const object = z.record(z.string(), z.unknown());
const metadata = z.object({ model: z.string().optional(), modelVersion: z.string().optional() });

function wire(config: Route, system: string, messages: readonly Message[]) {
  const headers = { 'content-type': 'application/json' };
  switch (config.provider) {
    case 'anthropic':
      return {
        url: `${config.endpoint}v1/messages`,
        headers: { ...headers, 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: config.model, max_tokens: config.maxOutputTokens, system, messages },
      };
    case 'google':
      return {
        url: `${config.endpoint}v1beta/models/${config.model}:generateContent`,
        headers: { ...headers, 'x-goog-api-key': config.apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map(message => ({
            role: message.role === 'user' ? 'user' : 'model',
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: config.maxOutputTokens },
        },
      };
    case 'openai':
    case 'xai':
    case 'openai-compatible':
    case 'azure': {
      const { base, auth } = openAiWire(config);
      const authorization = { ...headers, ...auth };
      const turns = [{ role: 'system', content: system }, ...messages];
      const capabilities = routeCapabilities(config);
      return capabilities.api === 'responses'
        ? {
            url: `${base}responses`,
            headers: authorization,
            body: {
              model: config.model,
              input: turns,
              max_output_tokens: config.maxOutputTokens,
              store: false,
              ...(capabilities.reasoningOffForTools ? { reasoning: { effort: 'none' } } : {}),
            },
          }
        : {
            url: `${base}chat/completions`,
            headers: authorization,
            body: {
              model: config.model,
              messages: turns,
              max_completion_tokens: config.maxOutputTokens,
              ...(config.provider === 'xai' ? {} : { store: false }),
              ...(capabilities.reasoningOffForTools ? { reasoning_effort: 'none' } : {}),
            },
          };
    }
  }
}

function usage(route: Route, body: unknown): InferenceUsage {
  if (route.provider === 'anthropic') {
    const parsed = z
      .object({
        usage: z.object({
          input_tokens: count,
          output_tokens: count,
          cache_read_input_tokens: count.default(0),
          cache_creation_input_tokens: count.default(0),
          cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }).nullish(),
        }),
      })
      .safeParse(body);
    if (!parsed.success) return unknown;
    const u = parsed.data.usage,
      ttl = u.cache_creation;
    if (ttl && ttl.ephemeral_5m_input_tokens + ttl.ephemeral_1h_input_tokens !== u.cache_creation_input_tokens)
      return unknown;
    return {
      ...empty,
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: ttl ? 0 : u.cache_creation_input_tokens,
      cacheWrite5m: ttl?.ephemeral_5m_input_tokens ?? 0,
      cacheWrite1h: ttl?.ephemeral_1h_input_tokens ?? 0,
    };
  }
  if (route.provider === 'google') {
    const parsed = z
      .object({
        usageMetadata: z.object({
          promptTokenCount: count,
          candidatesTokenCount: count.default(0),
          thoughtsTokenCount: count.default(0),
          cachedContentTokenCount: count.default(0),
          totalTokenCount: count,
          toolUsePromptTokenCount: count.default(0),
        }),
      })
      .safeParse(body);
    if (!parsed.success) return unknown;
    const u = parsed.data.usageMetadata;
    if (
      u.toolUsePromptTokenCount ||
      u.cachedContentTokenCount > u.promptTokenCount ||
      u.promptTokenCount + u.candidatesTokenCount + u.thoughtsTokenCount !== u.totalTokenCount
    )
      return unknown;
    return {
      ...empty,
      input: u.promptTokenCount - u.cachedContentTokenCount,
      output: u.candidatesTokenCount + u.thoughtsTokenCount,
      cacheRead: u.cachedContentTokenCount,
    };
  }
  const capabilities = routeCapabilities(route);
  if (capabilities.api === 'responses') {
    const parsed = z
      .object({
        usage: z.object({
          input_tokens: count,
          output_tokens: count,
          total_tokens: count,
          input_tokens_details: z.object({ cached_tokens: count }),
        }),
      })
      .safeParse(body);
    if (!parsed.success) return unknown;
    const u = parsed.data.usage;
    if (u.input_tokens_details.cached_tokens > u.input_tokens || u.input_tokens + u.output_tokens !== u.total_tokens)
      return unknown;
    return {
      ...empty,
      input: u.input_tokens - u.input_tokens_details.cached_tokens,
      cacheRead: u.input_tokens_details.cached_tokens,
      output: u.output_tokens,
    };
  }
  const parsed = z
    .object({
      usage: z.object({
        prompt_tokens: count,
        completion_tokens: count,
        total_tokens: count,
        prompt_tokens_details: z.object({ cached_tokens: count }).optional(),
        completion_tokens_details: z.object({ reasoning_tokens: count }).optional(),
      }),
    })
    .safeParse(body);
  if (!parsed.success) return unknown;
  const u = parsed.data.usage,
    cache = u.prompt_tokens_details?.cached_tokens ?? 0;
  const output =
    u.completion_tokens +
    (capabilities.reasoningTokensInOutput ? (u.completion_tokens_details?.reasoning_tokens ?? 0) : 0);
  if (cache > u.prompt_tokens || u.prompt_tokens + output !== u.total_tokens) return unknown;
  return { ...empty, input: u.prompt_tokens - cache, output, cacheRead: cache };
}

function text(route: Route, body: unknown): string {
  if (route.provider === 'anthropic') {
    const parsed = z.object({ stop_reason: z.string().nullable(), content: z.array(object) }).parse(body);
    if (parsed.content.some(block => block.type === 'tool_use' || block.type === 'server_tool_use'))
      throw new AgentAuthoringError('provider-tools-forbidden');
    if (parsed.stop_reason === 'refusal') throw new AgentAuthoringError('provider-refused');
    if (parsed.stop_reason !== 'end_turn') throw new AgentAuthoringError('provider-interrupted');
    return parsed.content
      .map(block =>
        z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('text'), text: z.string() }),
            z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
            z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
          ])
          .parse(block),
      )
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
      .join('');
  }
  if (route.provider === 'google') {
    const parsed = z
      .object({
        candidates: z
          .array(z.object({ finishReason: z.string().optional(), content: z.object({ parts: z.array(object) }) }))
          .length(1),
      })
      .parse(body);
    const candidate = parsed.candidates[0]!;
    if (
      candidate.content.parts.some(
        part => 'functionCall' in part || 'executableCode' in part || 'codeExecutionResult' in part,
      )
    )
      throw new AgentAuthoringError('provider-tools-forbidden');
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(candidate.finishReason ?? ''))
      throw new AgentAuthoringError('provider-refused');
    if (candidate.finishReason !== 'STOP') throw new AgentAuthoringError('provider-interrupted');
    return candidate.content.parts
      .map(part => z.object({ text: z.string(), thought: z.boolean().optional() }).parse(part))
      .filter(part => !part.thought)
      .map(part => part.text)
      .join('');
  }
  if (routeCapabilities(route).api === 'responses') {
    const parsed = z.object({ status: z.string(), output: z.array(object) }).parse(body);
    if (parsed.output.some(item => !['message', 'reasoning'].includes(String(item.type))))
      throw new AgentAuthoringError('provider-tools-forbidden');
    if (parsed.status !== 'completed') throw new AgentAuthoringError('provider-interrupted');
    return parsed.output
      .filter(item => item.type === 'message')
      .flatMap(item => {
        const message = z.object({ status: z.literal('completed'), content: z.array(object) }).parse(item);
        if (message.content.some(part => part.type === 'refusal')) throw new AgentAuthoringError('provider-refused');
        return message.content.map(
          part => z.object({ type: z.literal('output_text'), text: z.string() }).parse(part).text,
        );
      })
      .join('');
  }
  const parsed = z
    .object({
      choices: z
        .array(
          z.object({
            finish_reason: z.string().nullable(),
            message: z.object({
              content: z.string().nullable(),
              refusal: z.string().nullish(),
              tool_calls: z.array(z.unknown()).nullish(),
              function_call: z.unknown().optional(),
            }),
          }),
        )
        .length(1),
    })
    .parse(body);
  const choice = parsed.choices[0]!;
  if (choice.message.tool_calls?.length || choice.message.function_call != null)
    throw new AgentAuthoringError('provider-tools-forbidden');
  if (choice.message.refusal || choice.finish_reason === 'content_filter')
    throw new AgentAuthoringError('provider-refused');
  if (choice.finish_reason !== 'stop') throw new AgentAuthoringError('provider-interrupted');
  return z.string().parse(choice.message.content);
}

export function validateAgentAuthoringText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) ||
    value.includes('\0')
  )
    throw new AgentAuthoringError('provider-invalid-response');
  if (!value.trim()) throw new AgentAuthoringError('provider-empty-response');
  if (value.length > maximum) throw new AgentAuthoringError('provider-output-too-large');
  return value;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new AgentAuthoringError('provider-invalid-response');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let bytes = 0,
    body = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > agentAuthoringLimits.responseBytes) throw new AgentAuthoringError('provider-output-too-large');
      try {
        body += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new AgentAuthoringError('provider-invalid-response');
      }
    }
    try {
      body += decoder.decode();
    } catch {
      throw new AgentAuthoringError('provider-invalid-response');
    }
    return JSON.parse(body);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
  }
}

function providerError(status: number, body: unknown) {
  const parsed = z
    .union([
      z.object({
        error: z.object({
          code: z.union([z.string(), z.number()]).optional(),
          type: z.string().optional(),
          status: z.string().optional(),
          message: z.string().optional(),
        }),
      }),
      // xAI reports `{ code, error: "<message>" }`.
      z
        .object({ error: z.string(), code: z.union([z.string(), z.number()]).optional() })
        .transform(({ error, code }) => ({ error: { code, message: error, type: undefined, status: undefined } })),
    ])
    .safeParse(body);
  const code = parsed.success
    ? [parsed.data.error.code, parsed.data.error.type, parsed.data.error.status].join(' ')
    : '';
  const message = parsed.success ? (parsed.data.error.message ?? '') : '';
  if (status === 401 || (status === 400 && /incorrect api key/i.test(message)))
    return new AgentAuthoringError('provider-authentication');
  if (status === 403 && !/spending limit|credits/i.test(message)) return new AgentAuthoringError('provider-permission');
  if (
    status === 402 ||
    /quota|billing|credit/i.test(code) ||
    /credit balance|billing|spend (?:cap|limit)|spending limit|credits|daily.*quota/i.test(message)
  )
    return new AgentAuthoringError('provider-quota');
  if (status === 403) return new AgentAuthoringError('provider-permission');
  if (status === 429) return new AgentAuthoringError('provider-rate-limit');
  if (/content_filter|content_policy|refusal/i.test(code)) return new AgentAuthoringError('provider-refused');
  return new AgentAuthoringError('provider-unavailable');
}

// inferWithSystem cannot propagate caller cancellation or reject incomplete text; this transport shares its
// route contract and provider formats, but deliberately has no tool, memory, or runtime adapter.
export function prepareAgentAuthoringInference(
  route: InferenceRoute,
  system: string,
  messages: readonly Message[],
  maximum: number,
  fetcher: typeof fetch = fetch,
) {
  const config = inferenceRouteSchema.parse(route);
  const request = wire(config, system, messages),
    body = JSON.stringify(request.body);
  const inputBytes = Buffer.byteLength(body);
  if (inputBytes > agentAuthoringLimits.modelInputBytes) throw new AgentAuthoringError('input-too-large');
  return {
    inputBytes,
    maxOutputTokens: config.maxOutputTokens,
    async run(signal: AbortSignal, onUsage: (value: InferenceUsage) => void, onDispatch?: () => void) {
      return observeInference({ provider: config.provider, model: config.model, operation: 'chat' }, async report => {
        try {
          signal.throwIfAborted();
          onDispatch?.();
          const response = await fetcher(request.url, {
            method: 'POST',
            headers: request.headers,
            body,
            redirect: 'error',
            signal,
          });
          let json: unknown;
          try {
            json = await readBody(response, signal);
          } catch (error) {
            if (!response.ok && !signal.aborted) throw providerError(response.status, null);
            throw error;
          }
          const consumed = usage(config, json);
          onUsage(consumed);
          if (consumed.kind === 'known')
            report.usage(
              consumed.input + consumed.cacheRead + consumed.cacheWrite + consumed.cacheWrite5m + consumed.cacheWrite1h,
              consumed.output,
            );
          if (!response.ok) throw providerError(response.status, json);
          const model = metadata.parse(json);
          const actualModel = model.model ?? model.modelVersion;
          const suffix = actualModel?.startsWith(`${config.model}-`) ? actualModel.slice(config.model.length + 1) : '';
          if (actualModel !== config.model && !/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(suffix))
            throw new AgentAuthoringError('provider-model-mismatch');
          const answer = validateAgentAuthoringText(text(config, json), maximum);
          if (consumed.kind !== 'known') throw new AgentAuthoringError('provider-usage-unavailable');
          signal.throwIfAborted();
          return { text: answer, actualModel: actualModel! };
        } catch (error) {
          report.error();
          if (signal.aborted)
            throw new AgentAuthoringError(
              signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
                ? 'timed-out'
                : 'cancelled',
            );
          if (error instanceof AgentAuthoringError) throw error;
          if (error instanceof z.ZodError || error instanceof SyntaxError)
            throw new AgentAuthoringError('provider-invalid-response');
          throw new AgentAuthoringError('provider-unavailable');
        }
      });
    },
  };
}
