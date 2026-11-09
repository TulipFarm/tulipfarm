const reasoningBlock = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
const closingTag = /<\/think(?:ing)?>/gi;
const openingTag = /<think(?:ing)?>/i;
const anyTag = /<\/?think(?:ing)?>/gi;
const partialTag = /<\/?(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i;

/**
 * Chat text without the `<think>` reasoning markup some Chat Completions models, such as Kimi, leak into their answer
 * content. A complete reasoning block is removed. Text before a stray closing tag is reasoning, and text after a stray
 * opening tag is unfinished reasoning; each is dropped when other text remains and kept, without the tag, when it is all
 * the model wrote. `streaming` also hides a tag still arriving at the end and reasoning not yet closed.
 */
export function withoutReasoningMarkup(text: string, streaming = false): string {
  if (!text.includes('<')) return text;
  let rest = text.replace(reasoningBlock, '');
  const closings = [...rest.matchAll(closingTag)];
  const closing = closings.at(-1);
  if (closing) {
    const after = rest.slice(closing.index + closing[0].length);
    rest = after.trim() ? after : rest.slice(0, closing.index);
  }
  const opening = openingTag.exec(rest);
  if (opening) {
    const before = rest.slice(0, opening.index);
    rest = before.trim() || streaming ? before : rest.slice(opening.index + opening[0].length);
  }
  if (streaming) rest = rest.replace(partialTag, '');
  rest = rest.replace(anyTag, '');
  return rest === text ? text : rest.trim();
}
