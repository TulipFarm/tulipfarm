import { createHash } from 'node:crypto';

/** Provider wire formats used by chat. `responses` is the Azure Responses API that gpt-6-astra uses. */
export const formats = ['anthropic', 'azure', 'responses', 'google'];
export const nativeRoutes = {
  anthropic: {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/',
    model: 'claude-opus-5-5',
    apiKey: 'synthetic-key',
  },
  azure: {
    provider: 'azure',
    endpoint: 'https://synthetic.openai.azure.com/',
    model: 'synthetic-deployment',
    auth: { kind: 'api-key', value: 'synthetic-key' },
  },
  responses: {
    provider: 'azure',
    endpoint: 'https://synthetic.openai.azure.com/',
    model: 'gpt-6-astra',
    auth: { kind: 'api-key', value: 'synthetic-key' },
  },
  google: {
    provider: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/',
    model: 'gemini-synthetic',
    apiKey: 'synthetic-key',
  },
};

export function formatOf(target) {
  if (typeof target === 'string') return target;
  return target.provider === 'azure' && target.model === 'gpt-6-astra' ? 'responses' : target.provider;
}

export const nativeName = tool => tool.replaceAll('.', '_');
export const mcpName = handle => `mcp_${createHash('sha256').update(handle).digest('hex').slice(0, 24)}`;

/** One native tool call. `args` excludes `tool`; `activity` is the user-visible progress phrase. */
export function use(tool, args = {}, activity = 'Working on your request', extra = {}) {
  return { name: nativeName(tool), input: { activity, ...args }, ...extra };
}

/** Converts a framework call `{ tool, ...args }` to a native call. */
export function useCall({ tool, ...args }, activity, extra) {
  return use(tool, args, activity, extra);
}

const usage = {
  anthropic: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
  azure: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } },
  responses: { input_tokens: 13, output_tokens: 7, total_tokens: 20, input_tokens_details: { cached_tokens: 3 } },
  google: {
    promptTokenCount: 13,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 4,
    cachedContentTokenCount: 3,
    totalTokenCount: 20,
  },
};
export const knownUsage = {
  kind: 'known',
  input: 10,
  output: 7,
  cacheRead: 3,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

/**
 * A provider-native chat response. Calls without an `id` get `toolu_<n>` or `call_<n>`; Google calls carry an `id` only when one is given.
 * A Google call may carry a `thoughtSignature`, which the provider attaches to its part.
 */
export function nativeReply(target, { text = '', calls = [] } = {}) {
  const format = formatOf(target);
  const id = (call, index) => call.id ?? `${format === 'anthropic' ? 'toolu' : 'call'}_${index}`;
  switch (format) {
    case 'anthropic':
      return {
        model: 'actual-anthropic',
        stop_reason: calls.length ? 'tool_use' : 'end_turn',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...calls.map((call, index) => ({
            type: 'tool_use',
            id: id(call, index),
            name: call.name,
            input: call.input,
          })),
        ],
        usage: structuredClone(usage.anthropic),
      };
    case 'azure':
      return {
        model: 'actual-azure',
        choices: [
          {
            finish_reason: calls.length ? 'tool_calls' : 'stop',
            message: {
              content: text || null,
              ...(calls.length
                ? {
                    tool_calls: calls.map((call, index) => ({
                      id: id(call, index),
                      type: 'function',
                      function: {
                        name: call.name,
                        arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
                      },
                    })),
                  }
                : {}),
            },
          },
        ],
        usage: structuredClone(usage.azure),
      };
    case 'responses':
      return {
        model: 'gpt-6-astra',
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1' },
          ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
          ...calls.map((call, index) => ({
            type: 'function_call',
            id: `fc_${index}`,
            call_id: id(call, index),
            name: call.name,
            arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
            status: 'completed',
          })),
        ],
        usage: structuredClone(usage.responses),
      };
    case 'google':
      return {
        modelVersion: 'actual-google',
        responseId: 'google-response',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [
                ...(text ? [{ text }] : []),
                ...calls.map(call => ({
                  functionCall: { name: call.name, args: call.input, ...(call.id ? { id: call.id } : {}) },
                  ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
                })),
              ],
            },
          },
        ],
        usageMetadata: structuredClone(usage.google),
      };
    default:
      throw new Error('Unknown fixture format');
  }
}

/** A forced `select_action` response for independent structured checks. */
export function selectReply(target, decision) {
  const envelope = { decision };
  switch (formatOf(target)) {
    case 'anthropic':
      return {
        model: 'actual-anthropic',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_select', name: 'select_action', input: envelope }],
        usage: usage.anthropic,
      };
    case 'azure':
      return {
        model: 'actual-azure',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: 'call_select',
                  type: 'function',
                  function: { name: 'select_action', arguments: JSON.stringify(envelope) },
                },
              ],
            },
          },
        ],
        usage: usage.azure,
      };
    case 'responses':
      return {
        model: 'gpt-6-astra',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_select',
            status: 'completed',
            name: 'select_action',
            arguments: JSON.stringify(envelope),
          },
        ],
        usage: usage.responses,
      };
    case 'google':
      return {
        modelVersion: 'actual-google',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(envelope) }] } }],
        usageMetadata: usage.google,
      };
    default:
      throw new Error('Unknown fixture format');
  }
}

export function completionReply(target, status = 'completed') {
  return selectReply(target, { status, reason: 'The fixture answer satisfies the request.' });
}

export function isCompletionRequest(body) {
  const schema =
    body.generationConfig?.responseJsonSchema ??
    body.tools?.[0]?.input_schema ??
    body.tools?.[0]?.function?.parameters ??
    body.tools?.[0]?.parameters;
  return schema?.properties?.decision?.properties?.status?.enum?.includes('continue') === true;
}

/** The conversation items of a request body, excluding the system prompt. */
export function conversation(target, body) {
  switch (formatOf(target)) {
    case 'anthropic':
      return body.messages;
    case 'azure':
      return body.messages.slice(1);
    case 'responses':
      return body.input.slice(1);
    case 'google':
      return body.contents;
    default:
      throw new Error('Unknown fixture format');
  }
}

/** The tool results at the end of a request body, in order. */
export function toolResults(target, body) {
  const format = formatOf(target);
  const items = conversation(format, body);
  switch (format) {
    case 'anthropic': {
      const last = items.at(-1);
      return Array.isArray(last?.content)
        ? last.content
            .filter(block => block.type === 'tool_result')
            .map(block => ({ id: block.tool_use_id, output: block.content, error: block.is_error === true }))
        : [];
    }
    case 'azure': {
      const results = [];
      for (const message of items.toReversed()) {
        if (message.role !== 'tool') break;
        results.unshift({ id: message.tool_call_id, output: message.content });
      }
      return results;
    }
    case 'responses': {
      const results = [];
      for (const item of items.toReversed()) {
        if (item.type !== 'function_call_output') break;
        results.unshift({ id: item.call_id, output: item.output });
      }
      return results;
    }
    case 'google': {
      const last = items.at(-1);
      return (last?.parts ?? [])
        .filter(part => part.functionResponse)
        .map(({ functionResponse: { id, name, response } }) => ({
          ...(id === undefined ? {} : { id }),
          name,
          output: response.output ?? response.error,
          error: 'error' in response,
        }));
    }
    default:
      throw new Error('Unknown fixture format');
  }
}

/** Text of the last plain conversation message, such as a correction turn. */
export function lastText(target, body) {
  const last = conversation(target, body).at(-1);
  return formatOf(target) === 'google' ? last.parts[0].text : last.content;
}

/** Native tool definitions as `{ name, description, parameters }`, whichever provider shape the request used. */
export function offeredTools(target, body) {
  switch (formatOf(target)) {
    case 'anthropic':
      return body.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      }));
    case 'azure':
      return body.tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));
    case 'responses':
      return body.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    case 'google':
      return body.tools[0].functionDeclarations.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema,
      }));
    default:
      throw new Error('Unknown fixture format');
  }
}
