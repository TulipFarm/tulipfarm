import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A member's Claude or GitHub Copilot plan runs through the vendor's agent SDK, not a public HTTP API. This module
// answers the requests the tool loop sends for those routes as if it were the provider's API: Anthropic Messages for
// Claude, Chat Completions for Copilot. Each conversation keeps one live SDK session. When the model asks for tools,
// the session pauses inside its tool handlers and the request returns the calls; the loop runs them with its own
// tools, approvals and guards, and the next request's tool results resume the paused session. So the loop never sees
// the difference, and each user message costs the plan one request rather than one per tool round.

export type PlanSessionProvider = 'claude' | 'copilot';

type Call = { id: string; name: string; input: unknown };
type Result = { id: string; output: string; error: boolean };
type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: Call[] }
  | { role: 'tool'; results: Result[] };
type Tool = { name: string; description: string; parameters: object };
type Conversation = { model: string; system: string; messages: Message[]; tools: Tool[] };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Step =
  | { kind: 'calls'; text: string; calls: Call[]; usage: Usage }
  | { kind: 'answer'; text: string; usage: Usage };

/** A failure the vendor reported, answered as the HTTP error its classifier expects. */
/** A plan call that failed; `code` is the error code the adapter answers with, such as `plan_reconnect`. */
export class PlanSessionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const idleMs = 10 * 60_000;
/** An answered session only continues for a correction in the same reply; the next reply starts its own. */
const answeredIdleMs = 60_000;
const maxSessions = 200;

/** Answers one request of a Claude or Copilot plan route, in that provider's wire format. */
export async function planSessionFetch(
  provider: PlanSessionProvider,
  token: string,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  let conversation: Conversation;
  let streamed: boolean;
  try {
    const parsed = record(JSON.parse(body));
    conversation = provider === 'claude' ? fromAnthropic(parsed) : fromChatCompletions(parsed);
    streamed = parsed.stream === true;
  } catch {
    return errorResponse(new PlanSessionError(400, 'invalid_request', 'The request could not be read'));
  }
  signal?.throwIfAborted();
  let session: Session | undefined;
  try {
    session = await claim(provider, token, conversation);
    const claimed = session;
    if (streamed) return await streamStep(provider, claimed, conversation, signal);
    const step = await raceAbort(claimed.advance(conversation), signal, () => claimed.close());
    claimed.release();
    return Response.json(provider === 'claude' ? toAnthropic(step, conversation.model) : toChatCompletions(step));
  } catch (error) {
    session?.close();
    if (signal?.aborted) throw signal.reason;
    if (error instanceof PlanSessionError) return errorResponse(error);
    return errorResponse(
      new PlanSessionError(502, 'plan_unavailable', error instanceof Error ? error.message : 'The plan failed'),
    );
  }
}

function errorResponse(error: PlanSessionError) {
  return Response.json(
    { error: { code: error.code, type: error.code, message: error.message } },
    {
      status: error.status,
      headers: error.retryAfterSeconds === undefined ? {} : { 'retry-after': String(error.retryAfterSeconds) },
    },
  );
}

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return work;
  let stop: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

// Wire formats -----------------------------------------------------------------------------------------------------

/**
 * Streams one step as server-sent events in the provider's format. It waits for the first words or the end of the
 * step, so a failure before any output still answers with its HTTP error and status.
 */
async function streamStep(
  provider: PlanSessionProvider,
  session: Session,
  conversation: Conversation,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const events = provider === 'claude' ? anthropicEvents(conversation.model) : chatCompletionEvents();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
    cancel() {
      session.close();
    },
  });
  const emit = (chunk: string) => {
    if (!chunk) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      return;
    }
  };
  const first = new Deferred<void>();
  const work = raceAbort(
    session.advance(conversation, words => {
      emit(events.text(words));
      first.resolve();
    }),
    signal,
    () => session.close(),
  );
  await Promise.race([first.promise, work]);
  work.then(
    step => {
      session.release();
      emit(events.finish(step));
      controller.close();
    },
    (error: unknown) => {
      session.close();
      if (signal?.aborted) return controller.error(signal.reason);
      emit(events.fail(asPlanError(error)));
      controller.close();
    },
  );
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

const asPlanError = (error: unknown) =>
  error instanceof PlanSessionError
    ? error
    : new PlanSessionError(502, 'plan_unavailable', error instanceof Error ? error.message : 'The plan failed');

type StepEvents = {
  /** The next words of the answer. */
  text(words: string): string;
  /** The rest of the step: any words not yet sent, its tool calls, usage and stop reason. */
  finish(step: Step): string;
  fail(error: PlanSessionError): string;
};

const sse = (event: string | undefined, data: unknown) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** The words of `step` not yet streamed; deltas and the final message usually agree, so this is usually empty. */
const unsent = (step: Step, sent: string) => (step.text.startsWith(sent) ? step.text.slice(sent.length) : '');

function anthropicEvents(model: string): StepEvents {
  let started = false;
  let open = false;
  let sent = '';
  const start = () => {
    if (started) return '';
    started = true;
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const text = (words: string) => {
    if (!words) return '';
    let out = start();
    if (!open) {
      open = true;
      out += sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
    }
    sent += words;
    return (
      out +
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } })
    );
  };
  return {
    text,
    finish(step) {
      let out = start() + text(unsent(step, sent));
      if (open) out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      const calls = step.kind === 'calls' ? step.calls : [];
      calls.forEach((call, offset) => {
        const index = (open ? 1 : 0) + offset;
        out +=
          sse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
          }) +
          sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input ?? {}) },
          }) +
          sse('content_block_stop', { type: 'content_block_stop', index });
      });
      out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: step.kind === 'calls' ? 'tool_use' : 'end_turn' },
        usage: anthropicUsage(step.usage),
      });
      return out + sse('message_stop', { type: 'message_stop' });
    },
    fail(error) {
      return start() + sse('error', { type: 'error', error: { type: error.code, message: error.message } });
    },
  };
}

function chatCompletionEvents(): StepEvents {
  const id = `chatcmpl-${randomUUID()}`;
  let sent = '';
  const chunk = (delta: Json, finish: string | null = null) =>
    sse(undefined, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  const text = (words: string) => {
    if (!words) return '';
    const first = !sent;
    sent += words;
    return chunk(first ? { role: 'assistant', content: words } : { content: words });
  };
  return {
    text,
    finish(step) {
      let out = text(unsent(step, sent));
      if (step.kind === 'calls')
        out += chunk({
          ...(sent ? {} : { role: 'assistant' }),
          tool_calls: step.calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          })),
        });
      out += chunk({}, step.kind === 'calls' ? 'tool_calls' : 'stop');
      out += sse(undefined, { id, object: 'chat.completion.chunk', choices: [], usage: chatUsage(step.usage) });
      return out + sse(undefined, '[DONE]');
    },
    fail(error) {
      return (
        sse(undefined, { error: { code: error.code, type: error.code, message: error.message } }) +
        sse(undefined, '[DONE]')
      );
    },
  };
}

const anthropicUsage = (usage: Usage) => ({
  input_tokens: usage.input,
  output_tokens: usage.output,
  cache_read_input_tokens: usage.cacheRead,
  cache_creation_input_tokens: usage.cacheWrite,
});

function chatUsage(usage: Usage) {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value
    .map(part => {
      const block = record(part);
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'image' || block.type === 'image_url') return '[image]';
      return JSON.stringify(part);
    })
    .join('\n');
};

function fromAnthropic(body: Json): Conversation {
  const messages: Message[] = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(raw);
    const blocks = Array.isArray(message.content) ? message.content.map(record) : null;
    if (message.role === 'assistant') {
      const calls = (blocks ?? []).flatMap(block =>
        block.type === 'tool_use' ? [{ id: String(block.id), name: String(block.name), input: block.input }] : [],
      );
      const said = blocks
        ? blocks.flatMap(block => (block.type === 'text' ? [String(block.text)] : [])).join('')
        : text(message.content);
      messages.push({ role: 'assistant', text: said, calls });
      continue;
    }
    const results = (blocks ?? []).flatMap(block =>
      block.type === 'tool_result'
        ? [{ id: String(block.tool_use_id), output: text(block.content), error: block.is_error === true }]
        : [],
    );
    if (results.length) messages.push({ role: 'tool', results });
    const said = blocks ? text(blocks.filter(block => block.type !== 'tool_result')) : text(message.content);
    if (said || !results.length) messages.push({ role: 'user', text: said });
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(record).map(tool => ({
    name: String(tool.name),
    description: String(tool.description ?? ''),
    parameters: record(tool.input_schema),
  }));
  return { model: String(body.model), system: text(body.system), messages, tools };
}

function fromChatCompletions(body: Json): Conversation {
  const messages: Message[] = [];
  const system: string[] = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(raw);
    if (message.role === 'system' || message.role === 'developer') system.push(text(message.content));
    else if (message.role === 'assistant') {
      const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(record).map(call => {
        const fn = record(call.function);
        let input: unknown = {};
        try {
          input = JSON.parse(String(fn.arguments ?? '{}'));
        } catch {
          input = {};
        }
        return { id: String(call.id), name: String(fn.name), input };
      });
      messages.push({ role: 'assistant', text: text(message.content), calls });
    } else if (message.role === 'tool') {
      const result = { id: String(message.tool_call_id), output: text(message.content), error: false };
      const last = messages.at(-1);
      if (last?.role === 'tool') last.results.push(result);
      else messages.push({ role: 'tool', results: [result] });
    } else messages.push({ role: 'user', text: text(message.content) });
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(record).map(tool => {
    const fn = record(tool.function);
    return { name: String(fn.name), description: String(fn.description ?? ''), parameters: record(fn.parameters) };
  });
  return { model: String(body.model), system: system.join('\n\n'), messages, tools };
}

function toAnthropic(step: Step, model: string) {
  return {
    id: `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: step.kind === 'calls' ? 'tool_use' : 'end_turn',
    content: [
      ...(step.text ? [{ type: 'text', text: step.text }] : []),
      ...(step.kind === 'calls'
        ? step.calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input }))
        : []),
    ],
    usage: anthropicUsage(step.usage),
  };
}

function toChatCompletions(step: Step) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: step.kind === 'calls' ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: step.text || null,
          ...(step.kind === 'calls'
            ? {
                tool_calls: step.calls.map(call => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: chatUsage(step.usage),
  };
}

// Sessions ---------------------------------------------------------------------------------------------------------

/** What a request must start with to continue a session: the messages it has seen, compared by identity only. */
const shape = (message: Message) =>
  message.role === 'user'
    ? `u:${message.text}`
    : message.role === 'assistant'
      ? `a:${message.calls.map(call => call.id).join(',')}`
      : `t:${message.results.map(result => result.id).join(',')}`;

type Words = (words: string) => void;

type Vendor = {
  /** Sends the user's words and runs until the model asks for tools or answers, passing its words on as they come. */
  send(prompt: string, onText?: Words): Promise<Step>;
  /** Hands the paused tool calls their results and runs until the next tool request or answer. */
  resume(results: Result[], onText?: Words): Promise<Step>;
  close(): void;
};

class Session {
  seen: string[] = [];
  pending: Call[] = [];
  busy = false;
  closed = false;
  private timer: NodeJS.Timeout | undefined;

  readonly key: string;
  readonly vendor: Vendor;
  constructor(key: string, vendor: Vendor) {
    this.key = key;
    this.vendor = vendor;
  }

  /** Whether `messages` continues exactly what this session has seen. */
  continues(messages: readonly Message[]) {
    if (this.closed || this.busy || !this.seen.length || messages.length <= this.seen.length) return false;
    if (!this.seen.every((seen, index) => shape(messages[index]!) === seen)) return false;
    // Anything else, such as a tool round followed by its images, starts a new session that replays the transcript.
    const delta = messages.slice(this.seen.length);
    return this.pending.length
      ? delta.length === 1 && delta[0]!.role === 'tool'
      : delta.every(message => message.role === 'user');
  }

  async advance(conversation: Conversation, onText?: Words): Promise<Step> {
    const delta = conversation.messages.slice(this.seen.length);
    let step: Step;
    if (!this.seen.length) step = await this.vendor.send(startPrompt(conversation), onText);
    else if (this.pending.length) {
      const [first, ...rest] = delta;
      if (first?.role !== 'tool' || rest.length) throw new Error('unexpected continuation');
      // A call the loop did not run still needs an answer, or the paused session would wait for it forever.
      const results = [
        ...first.results,
        ...this.pending
          .filter(call => !first.results.some(result => result.id === call.id))
          .map(call => missing(call.id)),
      ];
      step = await this.vendor.resume(results, onText);
    } else {
      if (!delta.every(message => message.role === 'user')) throw new Error('unexpected continuation');
      step = await this.vendor.send(
        delta.map(message => (message.role === 'user' ? message.text : '')).join('\n\n'),
        onText,
      );
    }
    const answered: Message =
      step.kind === 'calls'
        ? { role: 'assistant', text: step.text, calls: step.calls }
        : { role: 'assistant', text: step.text, calls: [] };
    this.seen = [...conversation.messages, answered].map(shape);
    this.pending = step.kind === 'calls' ? step.calls : [];
    return step;
  }

  release() {
    this.busy = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), this.pending.length ? idleMs : answeredIdleMs);
    this.timer.unref?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    sessions.get(this.key)?.delete(this);
    try {
      this.vendor.close();
    } catch {
      return;
    }
  }
}

const sessions = new Map<string, Set<Session>>();
type OpenVendor = (
  provider: PlanSessionProvider,
  token: string,
  model: string,
  system: string,
  tools: Tool[],
) => Promise<Vendor>;
const vendors: OpenVendor = (provider, token, model, system, tools) =>
  provider === 'claude' ? claudeVendor(token, model, system, tools) : copilotVendor(token, model, system, tools);
let openVendor = vendors;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

async function claim(provider: PlanSessionProvider, token: string, conversation: Conversation) {
  const key = hash(
    [provider, token, conversation.model, conversation.tools.map(tool => tool.name).join(',')].join('\u0000'),
  );
  const pool = sessions.get(key) ?? new Set<Session>();
  sessions.set(key, pool);
  for (const session of pool)
    if (session.continues(conversation.messages)) {
      session.busy = true;
      return session;
    }
  const total = [...sessions.values()].reduce((sum, set) => sum + set.size, 0);
  if (total >= maxSessions) {
    const idle = [...sessions.values()].flatMap(set => [...set]).find(session => !session.busy);
    idle?.close();
  }
  const vendor = await openVendor(provider, token, conversation.model, startSystem(conversation), conversation.tools);
  const session = new Session(key, vendor);
  session.busy = true;
  pool.add(session);
  return session;
}

/** A new session carries the earlier conversation in its instructions and continues from the last message. */
function startSystem(conversation: Conversation) {
  const earlier = conversation.messages.slice(0, lastAssistant(conversation.messages) + 1);
  if (!earlier.length) return conversation.system;
  const transcript = earlier
    .map(message => {
      if (message.role === 'user') return `User: ${message.text}`;
      if (message.role === 'assistant')
        return [
          message.text && `Assistant: ${message.text}`,
          ...message.calls.map(call => `Assistant called ${call.name}(${JSON.stringify(call.input)}) [${call.id}]`),
        ]
          .filter(Boolean)
          .join('\n');
      return message.results
        .map(result => `Tool result [${result.id}]${result.error ? ' (error)' : ''}: ${result.output}`)
        .join('\n');
    })
    .join('\n\n');
  return `${conversation.system}\n\n<conversation_so_far>\n${transcript}\n</conversation_so_far>`;
}

function startPrompt(conversation: Conversation) {
  const rest = conversation.messages.slice(lastAssistant(conversation.messages) + 1);
  const prompt = rest
    .map(message =>
      message.role === 'user'
        ? message.text
        : message.role === 'tool'
          ? message.results
              .map(result => `Result of your call ${result.id}${result.error ? ' (error)' : ''}: ${result.output}`)
              .join('\n')
          : '',
    )
    .filter(Boolean)
    .join('\n\n');
  return prompt || 'Continue.';
}

function lastAssistant(messages: readonly Message[]) {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === 'assistant') return index;
  return -1;
}

/** One deferred result per tool call; handlers wait on them, the next request fills them. */
class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** The step a vendor session is running; tool requests and the end of the turn settle it. */
class Turn {
  readonly done = new Deferred<Step>();
  text: string[] = [];
  usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  failed?: PlanSessionError;
  settled = false;
  private readonly onText: Words | undefined;
  constructor(onText?: Words) {
    this.onText = onText;
  }
  /** Passes on the next words of the answer as the model writes them. */
  words(words: string) {
    if (!this.settled && words) this.onText?.(words);
  }
  calls(calls: Call[]) {
    this.settle({ kind: 'calls', text: this.text.join(''), calls, usage: this.usage });
  }
  answer() {
    this.settle({ kind: 'answer', text: this.text.join(''), usage: this.usage });
  }
  fail(error: PlanSessionError) {
    if (this.settled) return;
    this.settled = true;
    this.failed = error;
    this.done.reject(error);
  }
  private settle(step: Step) {
    if (this.settled) return;
    this.settled = true;
    this.done.resolve(step);
  }
}

const notRun = 'The tool was not run.';

// GitHub Copilot ---------------------------------------------------------------------------------------------------

/** The only environment a Copilot runtime sees: never the worker's database URLs or provider keys. */
const copilotEnv = (home: string) => ({
  HOME: home,
  PATH: process.env.PATH ?? '',
  COPILOT_AUTO_UPDATE: 'false',
  NO_UPDATE_NOTIFIER: '1',
});

type CopilotSdk = typeof import('@github/copilot-sdk');
let copilotClient: Promise<InstanceType<CopilotSdk['CopilotClient']>> | undefined;

async function copilot() {
  copilotClient ??= (async () => {
    const sdk = await import('@github/copilot-sdk');
    const baseDirectory = join(tmpdir(), 'tulipfarm-copilot');
    mkdirSync(baseDirectory, { recursive: true });
    const client = new sdk.CopilotClient({
      mode: 'empty',
      baseDirectory,
      env: copilotEnv(baseDirectory),
      useLoggedInUser: false,
      logLevel: 'error',
      sessionIdleTimeoutSeconds: idleMs / 1000 + 60,
    });
    await client.start();
    return client;
  })().catch(error => {
    copilotClient = undefined;
    throw error;
  });
  return copilotClient;
}

/** Signs in to Copilot with `token` and lists the models its plan offers. Throws a PlanSessionError if it cannot. */
export async function copilotPlanModels(token: string): Promise<string[]> {
  const sdk = await import('@github/copilot-sdk');
  const baseDirectory = join(tmpdir(), 'tulipfarm-copilot-check', hash(token));
  mkdirSync(baseDirectory, { recursive: true });
  const client = new sdk.CopilotClient({
    mode: 'empty',
    baseDirectory,
    env: copilotEnv(baseDirectory),
    gitHubToken: token,
    useLoggedInUser: false,
    logLevel: 'error',
  });
  try {
    await client.start();
    const models = await client.listModels();
    return models.map(model => model.id);
  } catch (error) {
    throw copilotError({ message: error instanceof Error ? error.message : String(error) });
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function copilotError(data: { errorType?: string; statusCode?: number; message?: string }) {
  const message = data.message || 'GitHub Copilot failed';
  const type = data.errorType ?? '';
  if (type === 'context_limit' || (!type && contextLimit.test(message)))
    return new PlanSessionError(400, 'context_length_exceeded', message);
  if (type === 'quota' || type === 'rate_limit' || data.statusCode === 429 || data.statusCode === 402)
    return new PlanSessionError(429, 'plan_usage_limit', message, 60);
  if (type === 'authentication' || data.statusCode === 401 || (!type && signedOut.test(message)))
    return new PlanSessionError(401, 'plan_reconnect', message);
  if (type === 'authorization' || type === 'policy' || data.statusCode === 403 || /not available/i.test(message))
    return new PlanSessionError(403, 'plan_not_eligible', message);
  return new PlanSessionError(502, 'plan_unavailable', message);
}

/**
 * Copilot accepts only letters, digits, _ and - in tool names, so dotted names such as tables.definitions travel
 * under a safe alias and map back before the loop sees the call.
 */
function toolAliases(names: readonly string[]) {
  const original = new Map<string, string>();
  const aliases = names.map(name => {
    const base = name.replace(/[^A-Za-z0-9_-]/g, '_');
    let alias = base;
    for (let n = 2; original.has(alias) || (names.includes(alias) && alias !== name); n++) alias = `${base}_${n}`;
    original.set(alias, name);
    return alias;
  });
  return { aliases, original };
}

async function copilotVendor(token: string, model: string, system: string, tools: Tool[]): Promise<Vendor> {
  const sdk = await import('@github/copilot-sdk');
  const client = await copilot();
  const { aliases, original } = toolAliases(tools.map(tool => tool.name));
  const results = new Map<string, Deferred<Result>>();
  const result = (id: string) => {
    let deferred = results.get(id);
    if (!deferred) results.set(id, (deferred = new Deferred()));
    return deferred;
  };
  let turn: Turn | undefined;
  const session = await client
    .createSession({
      model,
      gitHubToken: token,
      streaming: true,
      tools: tools.map((tool, index) =>
        sdk.defineTool(aliases[index]!, {
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
          skipPermission: true,
          // Ours replace any built-in of the same name, such as web_fetch, and stay loaded: with Copilot's own tools
          // off, the model has no tool search to find a deferred one.
          overridesBuiltInTool: true,
          defer: 'never',
          handler: async (_args: unknown, invocation: { toolCallId: string }) => {
            const answer = await result(invocation.toolCallId).promise;
            results.delete(invocation.toolCallId);
            return answer.error
              ? { textResultForLlm: answer.output, resultType: 'failure' as const }
              : { textResultForLlm: answer.output, resultType: 'success' as const };
          },
        }),
      ),
      // Only our tools: no shell, files or GitHub tools of Copilot's own.
      availableTools: ['custom:*'],
      disabledMcpServers: ['github-mcp-server'],
      systemMessage: { mode: 'replace', content: system },
      onPermissionRequest: () => ({ kind: 'approved' as const }),
    })
    .catch((error: unknown) => {
      throw copilotError({ message: error instanceof Error ? error.message : String(error) });
    });
  session.on(event => {
    const current = turn;
    if (!current) return;
    const data = record(event.data);
    switch (event.type) {
      case 'assistant.message_delta':
        if (typeof data.deltaContent === 'string') current.words(data.deltaContent);
        break;
      case 'assistant.message': {
        if (typeof data.content === 'string' && data.content) current.text.push(data.content);
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests.map(record) : [];
        if (requests.length)
          current.calls(
            requests.map(request => ({
              id: String(request.toolCallId),
              name: original.get(String(request.name)) ?? String(request.name),
              input: request.arguments ?? {},
            })),
          );
        break;
      }
      case 'assistant.usage':
        current.usage.input += Number(data.inputTokens ?? 0);
        current.usage.output += Number(data.outputTokens ?? 0);
        current.usage.cacheRead += Number(data.cacheReadTokens ?? 0);
        current.usage.cacheWrite += Number(data.cacheWriteTokens ?? 0);
        break;
      case 'session.error':
        current.fail(copilotError(data));
        break;
      case 'session.idle':
        current.answer();
        break;
    }
  });
  const begin = (onText?: Words) => (turn = new Turn(onText));
  return {
    async send(prompt, onText) {
      const current = begin(onText);
      await session.send({ prompt }).catch((error: unknown) => {
        current.fail(copilotError({ message: error instanceof Error ? error.message : String(error) }));
      });
      return current.done.promise;
    },
    async resume(given, onText) {
      const current = begin(onText);
      for (const item of given) result(item.id).resolve(item);
      return current.done.promise;
    },
    close() {
      for (const [id, deferred] of results) deferred.resolve(missing(id));
      void session.disconnect().catch(() => undefined);
    },
  };
}

const missing = (id: string): Result => ({ id, output: notRun, error: true });

// Claude -----------------------------------------------------------------------------------------------------------

const claudeToolPrefix = 'mcp__tulipfarm__';

/** Runs one tiny request with `token` to check that it signs in to a Claude plan. */
export async function checkClaudePlan(token: string, model = 'claude-haiku-4-5'): Promise<void> {
  const vendor = await claudeVendor(token, model, 'Answer with the single word OK.', []);
  try {
    await vendor.send('OK?');
  } finally {
    vendor.close();
  }
}

async function claudeVendor(token: string, model: string, system: string, tools: Tool[]): Promise<Vendor> {
  const [{ query }, { McpServer }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import('@anthropic-ai/claude-agent-sdk'),
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const home = join(tmpdir(), 'tulipfarm-claude', randomUUID());
  mkdirSync(home, { recursive: true });
  // Claude's MCP handler does not see the tool_use id, so a call is matched to its tool_use block by name and
  // arguments. Claude may run calls one after another, so a call can arrive after the loop already answered it.
  const unclaimed: Call[] = [];
  let fresh: Call[] = [];
  const answers = new Map<string, Result>();
  const waiting = new Map<string, Deferred<Result>>();
  let turn: Turn | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  // Once a handler waits, the model's message is complete; a short pause lets every tool_use block arrive.
  const settle = () => {
    const current = turn;
    if (!current || current.settled || !waiting.size || !fresh.length) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (turn !== current || current.settled) return;
      const calls = fresh;
      fresh = [];
      current.calls(calls);
    }, 25);
  };
  const find = (name: string, args: string) =>
    unclaimed.find(call => call.name === name && JSON.stringify(call.input ?? {}) === args) ??
    unclaimed.find(call => call.name === name);
  const server = new McpServer({ name: 'tulipfarm', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: 'object' },
      // Lets Claude ask for several calls at once; the loop decides how each one runs.
      annotations: { readOnlyHint: true },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = JSON.stringify(request.params.arguments ?? {});
    let call = find(request.params.name, args);
    for (let tries = 0; !call && tries < 200; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      call = find(request.params.name, args);
    }
    if (!call) return { content: [{ type: 'text' as const, text: notRun }], isError: true };
    unclaimed.splice(unclaimed.indexOf(call), 1);
    let answer = answers.get(call.id);
    answers.delete(call.id);
    if (!answer) {
      const deferred = new Deferred<Result>();
      waiting.set(call.id, deferred);
      settle();
      answer = await deferred.promise;
    }
    return { content: [{ type: 'text' as const, text: answer.output }], isError: answer.error };
  });
  const inbox: { push(prompt: string): void; end(): void; stream: AsyncIterable<unknown> } = (() => {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    return {
      push(prompt) {
        queue.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
        wake?.();
      },
      end() {
        ended = true;
        wake?.();
      },
      stream: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (queue.length) yield queue.shift();
            if (ended) return;
            await new Promise<void>(resolve => (wake = resolve));
            wake = undefined;
          }
        },
      },
    };
  })();
  const abort = new AbortController();
  const run = query({
    prompt: inbox.stream as never,
    options: {
      model,
      systemPrompt: system,
      tools: [],
      mcpServers: { tulipfarm: { type: 'sdk', name: 'tulipfarm', instance: server as never } },
      allowedTools: tools.map(tool => claudeToolPrefix + tool.name),
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      cwd: home,
      abortController: abort,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        HOME: home,
        PATH: process.env.PATH ?? '',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'tulipfarm',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
      },
    },
  });
  const counted = new Set<string>();
  let limited: PlanSessionError | undefined;
  void (async () => {
    try {
      for await (const raw of run) {
        const message = record(raw);
        const current = turn;
        if (message.type === 'rate_limit_event') {
          const info = record(message.rate_limit_info);
          if (info.status === 'rejected') {
            const resets = Number(info.resetsAt ?? 0);
            const wait = resets ? Math.max(1, Math.ceil(resets - Date.now() / 1000)) : 60;
            limited = new PlanSessionError(429, 'plan_usage_limit', 'Claude usage limit reached', wait);
          }
          continue;
        }
        if (!current) continue;
        if (message.type === 'stream_event') {
          const event = record(message.event);
          const delta = record(event.delta);
          if (message.parent_tool_use_id == null && event.type === 'content_block_delta' && delta.type === 'text_delta')
            current.words(String(delta.text ?? ''));
          continue;
        }
        if (message.type === 'assistant') {
          const body = record(message.message);
          if (body.model === '<synthetic>') {
            current.fail(limited ?? claudeError(text(body.content)));
            continue;
          }
          const id = String(body.id ?? '');
          const usage = record(body.usage);
          if (id && !counted.has(id)) {
            counted.add(id);
            current.usage.input += Number(usage.input_tokens ?? 0);
            current.usage.output += Number(usage.output_tokens ?? 0);
            current.usage.cacheRead += Number(usage.cache_read_input_tokens ?? 0);
            current.usage.cacheWrite += Number(usage.cache_creation_input_tokens ?? 0);
          }
          for (const block of Array.isArray(body.content) ? body.content.map(record) : []) {
            if (block.type === 'text' && typeof block.text === 'string') current.text.push(block.text);
            if (block.type === 'tool_use') {
              const call = {
                id: String(block.id),
                name: String(block.name).replace(claudeToolPrefix, ''),
                input: block.input ?? {},
              };
              unclaimed.push(call);
              fresh.push(call);
            }
          }
          settle();
        } else if (message.type === 'result') {
          if (message.is_error === true || (message.subtype !== 'success' && message.subtype !== undefined))
            current.fail(limited ?? claudeError(text(message.errors ?? message.result)));
          else current.answer();
        }
      }
      turn?.fail(limited ?? new PlanSessionError(502, 'plan_unavailable', 'Claude ended the session'));
    } catch (error) {
      turn?.fail(limited ?? claudeError(error instanceof Error ? error.message : String(error)));
    }
  })();
  return {
    async send(prompt, onText) {
      const current = (turn = new Turn(onText));
      fresh = [];
      limited = undefined;
      inbox.push(prompt);
      return current.done.promise;
    },
    async resume(given, onText) {
      const current = (turn = new Turn(onText));
      for (const item of given) {
        const deferred = waiting.get(item.id);
        waiting.delete(item.id);
        if (deferred) deferred.resolve(item);
        else answers.set(item.id, item);
      }
      return current.done.promise;
    },
    close() {
      clearTimeout(settleTimer);
      for (const [id, deferred] of waiting) deferred.resolve(missing(id));
      waiting.clear();
      inbox.end();
      abort.abort();
    },
  };
}

/** Checked first: size errors mention tokens, and reading one as a sign-out would discard the member's token. */
const contextLimit = /context (?:window|length|limit)|too long|too large|exceeds? the maximum|maximum context/i;
const signedOut =
  /bad credentials|unauthori[sz]ed|\b401\b|invalid api key|oauth token|(?:token|credential)s? (?:is |has )?(?:invalid|expired|revoked)|(?:invalid|expired|revoked) (?:oauth )?(?:token|credential)|please (?:run \/)?log ?in|not logged in/i;

function claudeError(message: string) {
  if (contextLimit.test(message)) return new PlanSessionError(400, 'context_length_exceeded', message);
  if (/usage limit|rate limit|limit reached|resets/i.test(message))
    return new PlanSessionError(429, 'plan_usage_limit', message, 60);
  if (signedOut.test(message)) return new PlanSessionError(401, 'plan_reconnect', message);
  if (/permission|\b403\b|not allowed|not available|subscription/i.test(message))
    return new PlanSessionError(403, 'plan_not_eligible', message);
  return new PlanSessionError(502, 'plan_unavailable', message || 'Claude failed');
}

export const planSessionsForTest = {
  fromAnthropic,
  fromChatCompletions,
  toAnthropic,
  toChatCompletions,
  toolAliases,
  claudeError,
  copilotError,
  sessions,
  /** Replaces the vendor SDKs; pass nothing to restore them. */
  useVendors(fake?: OpenVendor) {
    openVendor = fake ?? vendors;
  },
};
