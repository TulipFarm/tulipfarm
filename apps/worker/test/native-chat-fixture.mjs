import { createHash } from 'node:crypto';
import { completionReply as providerCompletionReply } from '../../../packages/agents/test/native-fixture.mjs';
export { isCompletionRequest } from '../../../packages/agents/test/native-fixture.mjs';

/** Provider-native function name for a framework chat tool or an admitted MCP handle. */
export const nativeToolName = tool => tool.replaceAll('.', '_');
export const mcpToolName = handle => `mcp_${createHash('sha256').update(handle).digest('hex').slice(0, 24)}`;

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
export const completionReply = (target, status) =>
  target === 'anthropic'
    ? { ...providerCompletionReply(target, status), usage }
    : providerCompletionReply(target, status);

/** One native tool_use block. MCP calls become the per-handle function with `{ activity, arguments }`. */
export function toolUse({ tool, ...fields }, activity = 'Working on your request', id = 'toolu_1') {
  if (tool === 'mcp.call')
    return { type: 'tool_use', id, name: mcpToolName(fields.handle), input: { activity, arguments: fields.arguments } };
  return { type: 'tool_use', id, name: nativeToolName(tool), input: { activity, ...fields } };
}

/** Anthropic native tool-call response. `calls` holds framework calls or `{ call, text }` entries; several calls run as one parallel read step. */
export function anthropicTools(calls, extra = {}) {
  const blocks = calls.map((entry, index) =>
    entry.call
      ? toolUse(entry.call, entry.text || undefined, `toolu_${index + 1}`)
      : toolUse(entry, undefined, `toolu_${index + 1}`),
  );
  return { stop_reason: 'tool_use', content: blocks, usage, ...extra };
}

/** Anthropic native final answer. */
export const anthropicText = (text, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage,
  ...extra,
});

/** Converts a legacy chat decision fixture (`answer`, `tool`, or `parallel`) into the Anthropic native response body. */
export function anthropicChat(decision, extra = {}) {
  if (decision.kind === 'answer') return anthropicText(decision.text, extra);
  if (decision.kind === 'parallel') return anthropicTools(decision.calls, extra);
  if (decision.kind === 'tool') return anthropicTools([{ call: decision.call, text: decision.text }], extra);
  throw new Error(`Unsupported chat fixture decision ${decision.kind}`);
}

/** True for the plain-text chat title request that follows a final answer when the responder asks for a title. */
export const isTitleRequest = body =>
  !body.tools && (body.system?.[0]?.text ?? '').startsWith('Write a title for a new chat.');
/** True for the structured Calendar text check, which still forces the `select_action` tool. */
export const isCalendarCheck = body =>
  body.tools?.[0]?.name === 'select_action' &&
  body.tools[0].input_schema?.properties?.decision?.properties?.summary !== undefined;
/** Tool result strings that the previous native steps returned to the model, oldest first. */
export const toolResults = body =>
  (body.messages ?? []).flatMap(message =>
    Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result').map(block => block.content)
      : [],
  );

/** Converts a legacy chat decision fixture into the Azure chat-completions native response body. */
export function azureChat(decision, extra = {}) {
  if (decision.kind === 'answer')
    return { choices: [{ finish_reason: 'stop', message: { content: decision.text } }], ...extra };
  const entries = decision.kind === 'parallel' ? decision.calls : [{ call: decision.call, text: decision.text }];
  const tool_calls = entries.map((entry, index) => {
    const { name, input } = entry.call ? toolUse(entry.call, entry.text || undefined) : toolUse(entry);
    return { id: `call_${index + 1}`, type: 'function', function: { name, arguments: JSON.stringify(input) } };
  });
  return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls } }], ...extra };
}
