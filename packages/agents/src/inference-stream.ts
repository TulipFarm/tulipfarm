import { z } from 'zod';

export type StreamFormat = 'anthropic' | 'chat-completions' | 'responses' | 'gemini';
/** `body` has the provider's non-streaming response shape; `error` is a `{ error }` envelope from an in-stream error event. */
export type StreamedResponse = { body: unknown; error: unknown };
export type ServerSentEvent = { event: string; data: string };

/** Body fields that ask for a streamed response; Gemini streams through its `streamGenerateContent?alt=sse` URL instead. */
export function streamRequestFields(format: StreamFormat) {
  if (format === 'gemini') return {};
  return format === 'chat-completions' ? { stream: true, stream_options: { include_usage: true } } : { stream: true };
}

/** The Gemini `generateContent` URL rewritten to its SSE streaming form; other formats keep their URL. */
export function streamUrl(format: StreamFormat, url: string) {
  return format === 'gemini' ? url.replace(/:generateContent$/, ':streamGenerateContent?alt=sse') : url;
}

export async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const line = (text: string): ServerSentEvent | undefined => {
    if (text === '') {
      const dispatched = data.length ? { event: event || 'message', data: data.join('\n') } : undefined;
      event = '';
      data = [];
      return dispatched;
    }
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(text[colon + 1] === ' ' ? colon + 2 : colon + 1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const end = buffer.search(/[\r\n]/);
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (end < 0 || (!done && end === buffer.length - 1 && buffer[end] === '\r')) break;
        const next = buffer[end] === '\r' && buffer[end + 1] === '\n' ? end + 2 : end + 1;
        const dispatched = line(buffer.slice(0, end));
        buffer = buffer.slice(next);
        if (dispatched) yield dispatched;
      }
      if (done) {
        const last = buffer ? line(buffer) : undefined;
        const tail = line('');
        if (last) yield last;
        if (tail) yield tail;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type Assembler = {
  push(event: ServerSentEvent): boolean | void;
  /** The plain answer text so far, '' once the model starts a tool call, or undefined while there is nothing to show. */
  visible(): string | undefined;
  result(): StreamedResponse;
};

function eventJson(data: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(data) };
  } catch {
    return { ok: false };
  }
}

const record = z.record(z.string(), z.unknown());
const anthropicEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), message: record }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: z.object({ type: z.string() }).loose(),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: z.object({
      type: z.string(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
      thinking: z.unknown().optional(),
    }),
  }),
  z.object({ type: z.literal('content_block_stop') }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullish() }),
    usage: record.nullish(),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('error'), error: record }),
]);
const anthropicEventTypes = new Set<string>(anthropicEventSchema.options.map(option => option.shape.type.value));

function anthropicAssembler(): Assembler {
  let message: Record<string, unknown> | undefined;
  const blocks: { start: { type: string } & Record<string, unknown>; text: string; json: string }[] = [];
  let stopReason: string | null = null;
  let finalUsage: Record<string, unknown> | undefined;
  let error: unknown = null;
  let broken = false;
  return {
    push({ data }) {
      const json = eventJson(data);
      if (!json.ok) {
        broken = true;
        return;
      }
      const parsed = anthropicEventSchema.safeParse(json.value);
      if (!parsed.success) {
        const type = record.safeParse(json.value).data?.type;
        if (typeof type !== 'string' || anthropicEventTypes.has(type)) broken = true;
        return;
      }
      const event = parsed.data;
      switch (event.type) {
        case 'message_start':
          message = event.message;
          break;
        case 'content_block_start':
          if (event.index !== blocks.length) {
            broken = true;
            break;
          }
          blocks.push({
            start: event.content_block,
            text: typeof event.content_block.text === 'string' ? event.content_block.text : '',
            json: '',
          });
          return (
            event.content_block.type === 'text' &&
            typeof event.content_block.text === 'string' &&
            event.content_block.text.length > 0
          );
        case 'content_block_delta': {
          const block = blocks[event.index];
          if (!block) {
            broken = true;
            break;
          }
          if (event.delta.type === 'text_delta') block.text += event.delta.text ?? '';
          if (event.delta.type === 'input_json_delta') block.json += event.delta.partial_json ?? '';
          return Boolean(
            (event.delta.type === 'text_delta' && event.delta.text) ||
            (event.delta.type === 'input_json_delta' && event.delta.partial_json) ||
            (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string' && event.delta.thinking),
          );
        }
        case 'message_delta':
          stopReason = event.delta.stop_reason ?? stopReason;
          // message_delta usage is cumulative; null fields keep the message_start value.
          finalUsage = {
            ...(finalUsage ?? record.safeParse(message?.usage).data),
            ...Object.fromEntries(Object.entries(event.usage ?? {}).filter(([, value]) => value !== null)),
          };
          break;
        case 'error':
          error = { error: event.error };
          break;
        default:
          break;
      }
    },
    visible() {
      if (blocks.some(block => block.start.type === 'tool_use')) return '';
      return blocks.flatMap(block => (block.start.type === 'text' ? [block.text] : [])).join('') || undefined;
    },
    result() {
      if (broken || !message) return { body: null, error };
      const { usage: _startUsage, ...rest } = message;
      const content = blocks.map(block => {
        if (block.start.type === 'text') return { ...block.start, text: block.text };
        if (block.start.type !== 'tool_use') return block.start;
        try {
          return { ...block.start, input: JSON.parse(block.json || '{}') };
        } catch {
          return { type: 'invalid_tool_use' };
        }
      });
      return {
        body: { ...rest, stop_reason: stopReason, content, ...(finalUsage ? { usage: finalUsage } : {}) },
        error,
      };
    },
  };
}

const chatChunkSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        finish_reason: z.string().nullish(),
        delta: z
          .object({
            content: z.string().nullish(),
            refusal: z.string().nullish(),
            reasoning_content: z.unknown().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative(),
                  id: z.string().nullish(),
                  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
  usage: record.nullish(),
  error: record.nullish(),
});

function chatAssembler(): Assembler {
  let model: string | undefined;
  let content: string | null = null;
  let refusal: string | null = null;
  let finishReason: string | null = null;
  let finalUsage: Record<string, unknown> | undefined;
  let error: unknown = null;
  let broken = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const ordered = () => [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
  return {
    push({ data }) {
      if (data === '[DONE]') return;
      const json = eventJson(data);
      const parsed = json.ok ? chatChunkSchema.safeParse(json.value) : undefined;
      if (!parsed?.success) {
        broken = true;
        return;
      }
      const chunk = parsed.data;
      model ||= chunk.model;
      if (chunk.usage) finalUsage = chunk.usage;
      if (chunk.error) error = { error: chunk.error };
      for (const choice of chunk.choices ?? []) {
        if (choice.index !== 0) continue;
        finishReason = choice.finish_reason ?? finishReason;
        if (choice.delta?.content) content = (content ?? '') + choice.delta.content;
        if (choice.delta?.refusal) refusal = (refusal ?? '') + choice.delta.refusal;
        for (const delta of choice.delta?.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
          calls.set(delta.index, call);
          if (delta.id) call.id = delta.id;
          if (delta.function?.name) call.name = delta.function.name;
          call.arguments += delta.function?.arguments ?? '';
        }
      }
      return (chunk.choices ?? []).some(
        choice =>
          choice.index === 0 &&
          Boolean(
            choice.delta?.content ||
            choice.delta?.refusal ||
            (typeof choice.delta?.reasoning_content === 'string' && choice.delta.reasoning_content) ||
            choice.delta?.tool_calls?.some(delta => Boolean(delta.function?.arguments)),
          ),
      );
    },
    visible() {
      if (calls.size) return '';
      return content ?? undefined;
    },
    result() {
      if (broken) return { body: null, error };
      const toolCalls = ordered().map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
      return {
        body: {
          ...(model ? { model } : {}),
          choices: [
            {
              finish_reason: finishReason,
              message: { content, refusal, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            },
          ],
          ...(finalUsage ? { usage: finalUsage } : {}),
        },
        error,
      };
    },
  };
}

const responsesEventSchema = z.object({
  type: z.string(),
  response: record.optional(),
  item: z.object({ type: z.string(), id: z.string().optional() }).loose().optional(),
  item_id: z.string().optional(),
  delta: z.string().optional(),
  code: z.string().nullish(),
  message: z.string().optional(),
});

function responsesAssembler(): Assembler {
  let final: Record<string, unknown> | null = null;
  let error: unknown = null;
  let broken = false;
  let calling = false;
  let text = '';
  return {
    push({ data }) {
      const json = eventJson(data);
      const parsed = json.ok ? responsesEventSchema.safeParse(json.value) : undefined;
      if (!parsed?.success) {
        broken = true;
        return;
      }
      const event = parsed.data;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type))
        final = event.response ?? null;
      else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') calling = true;
      else if (event.type === 'response.output_text.delta') text += event.delta ?? '';
      else if (event.type === 'error')
        error = { error: { type: 'error', code: event.code ?? undefined, message: event.message } };
      return (
        [
          'response.output_text.delta',
          'response.function_call_arguments.delta',
          'response.refusal.delta',
          'response.reasoning_text.delta',
          'response.reasoning_summary_text.delta',
        ].includes(event.type) && Boolean(event.delta)
      );
    },
    visible() {
      if (calling) return '';
      return text || undefined;
    },
    result() {
      return { body: broken ? null : final, error };
    },
  };
}

const geminiChunkSchema = z.object({
  candidates: z
    .array(
      z.object({
        index: z.number().int().nonnegative().optional(),
        finishReason: z.string().optional(),
        content: z.object({ role: z.string().optional(), parts: z.array(record).optional() }).optional(),
      }),
    )
    .optional(),
  usageMetadata: record.optional(),
  promptFeedback: record.optional(),
  modelVersion: z.string().optional(),
  responseId: z.string().optional(),
  error: record.optional(),
});

/** Each Gemini SSE chunk is a partial `GenerateContentResponse`; parts concatenate and usage is cumulative. */
function geminiAssembler(): Assembler {
  const parts: Record<string, unknown>[] = [];
  let finishReason: string | undefined;
  let usageMetadata: Record<string, unknown> | undefined;
  let promptFeedback: Record<string, unknown> | undefined;
  let modelVersion: string | undefined;
  let responseId: string | undefined;
  let error: unknown = null;
  let broken = false;
  let seen = false;
  const textPart = (part: Record<string, unknown>) =>
    typeof part.text === 'string' && !('functionCall' in part) && !('executableCode' in part);
  return {
    push({ data }) {
      const json = eventJson(data);
      const parsed = json.ok ? geminiChunkSchema.safeParse(json.value) : undefined;
      if (!parsed?.success) {
        broken = true;
        return;
      }
      const chunk = parsed.data;
      seen = true;
      modelVersion ||= chunk.modelVersion;
      responseId ||= chunk.responseId;
      if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
      if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback;
      if (chunk.error) error = { error: chunk.error };
      let changed = false;
      for (const candidate of chunk.candidates ?? []) {
        if ((candidate.index ?? 0) !== 0) continue;
        finishReason = candidate.finishReason ?? finishReason;
        for (const part of candidate.content?.parts ?? []) {
          const last = parts.at(-1);
          if (last && textPart(last) && textPart(part) && Boolean(last.thought) === Boolean(part.thought)) {
            last.text = `${String(last.text)}${String(part.text)}`;
            if (part.thoughtSignature !== undefined) last.thoughtSignature = part.thoughtSignature;
          } else parts.push({ ...part });
          changed ||= Boolean(part.functionCall) || (typeof part.text === 'string' && part.text.length > 0);
        }
      }
      return changed;
    },
    visible() {
      if (parts.some(part => 'functionCall' in part)) return '';
      return (
        parts
          .filter(part => textPart(part) && !part.thought)
          .map(part => String(part.text))
          .join('') || undefined
      );
    },
    result() {
      if (broken || !seen) return { body: null, error };
      return {
        body: {
          ...(parts.length || finishReason
            ? { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] }
            : {}),
          ...(usageMetadata ? { usageMetadata } : {}),
          ...(promptFeedback ? { promptFeedback } : {}),
          ...(modelVersion ? { modelVersion } : {}),
          ...(responseId ? { responseId } : {}),
        },
        error,
      };
    },
  };
}

const assemblers: Record<StreamFormat, () => Assembler> = {
  anthropic: anthropicAssembler,
  'chat-completions': chatAssembler,
  responses: responsesAssembler,
  gemini: geminiAssembler,
};

/** Reads an SSE model response into its non-streaming body shape, reporting each change of the visible answer. Other responses parse as JSON. */
export async function readModelResponse(
  response: Response,
  format: StreamFormat | null,
  options: { onText: ((text: string) => void) | undefined; onFirstToken?: () => void },
): Promise<StreamedResponse> {
  if (
    !format ||
    !response.ok ||
    !response.body ||
    !/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')
  )
    return { body: await response.json(), error: null };
  const assembler = assemblers[format]();
  let shown = '';
  let firstToken = false;
  for await (const event of serverSentEvents(response.body)) {
    if (assembler.push(event) && !firstToken) {
      firstToken = true;
      options.onFirstToken?.();
    }
    if (!options.onText) continue;
    const text = assembler.visible();
    if (text === undefined || text === shown) continue;
    shown = text;
    options.onText(text);
  }
  return assembler.result();
}
