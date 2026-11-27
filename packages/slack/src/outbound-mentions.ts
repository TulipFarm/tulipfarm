import {
  resolveOutboundMemberIdentities,
  type IdentityTransaction,
  type OutboundMemberTarget,
} from '@tulipfarm/integrations/member-identities';
import {
  parseSlackSurface,
  type RichTextElement,
  type SlackBlock,
  type SlackMessage,
  type SlackRichBlockElement,
  type SlackRichElement,
} from '@tulipfarm/slack-presentation';

const slackUserIdPattern = /^[UW][A-Z0-9]+$/;
const handleBoundaryBlocked = /[A-Za-z0-9._%+\-/\\<]/;
const handleChar = /[A-Za-z0-9._-]/;
const handleStart = /[A-Za-z0-9]/;
const reservedBroadcasts = new Set(['channel', 'here', 'everyone']);

export type OutboundMentionSpan =
  | { kind: 'handle'; start: number; end: number; handle: string }
  | { kind: 'userId'; start: number; end: number; userId: string };

export type OutboundMentionResolution = {
  byHandle: ReadonlyMap<string, Pick<OutboundMemberTarget, 'externalId'>>;
  knownExternalIds: ReadonlySet<string>;
};

export type ResolvedSlackOutboundMentions = {
  text: string;
  mentionUserIds: ReadonlySet<string>;
};

function validSlackUserId(value: string): boolean {
  return slackUserIdPattern.test(value);
}

function skipFencedCodeBlock(text: string, index: number): number | null {
  if (index > 0 && text[index - 1] !== '\n') return null;
  let pos = index;
  while (pos < text.length && pos - index < 3 && text[pos] === ' ') pos++;
  const fenceChar = text[pos];
  if (fenceChar !== '`' && fenceChar !== '~') return null;
  let fenceLen = 0;
  while (pos + fenceLen < text.length && text[pos + fenceLen] === fenceChar) fenceLen++;
  if (fenceLen < 3) return null;
  let cursor = text.indexOf('\n', pos + fenceLen);
  if (cursor < 0) return text.length;
  cursor++;
  while (cursor < text.length) {
    const lineEnd = text.indexOf('\n', cursor);
    const end = lineEnd < 0 ? text.length : lineEnd;
    let p = cursor;
    while (p < end && p - cursor < 3 && text[p] === ' ') p++;
    let count = 0;
    while (p + count < end && text[p + count] === fenceChar) count++;
    if (count >= fenceLen && text.slice(p + count, end).trim() === '') return lineEnd < 0 ? text.length : lineEnd + 1;
    cursor = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return text.length;
}

function skipInlineCodeSpan(text: string, index: number): number | null {
  if (text[index] !== '`') return null;
  let ticks = 0;
  while (index + ticks < text.length && text[index + ticks] === '`') ticks++;
  let cursor = index + ticks;
  while (cursor < text.length) {
    const next = text.indexOf('`', cursor);
    if (next < 0) return null;
    let close = 0;
    while (next + close < text.length && text[next + close] === '`') close++;
    if (close === ticks) return next + close;
    cursor = next + close;
  }
  return null;
}

function skipMarkdownLink(text: string, index: number): number | null {
  const start = text[index] === '!' && text[index + 1] === '[' ? index + 1 : text[index] === '[' ? index : -1;
  if (start < 0) return null;
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === '\n' && text[cursor + 1] === '\n') return null;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
    cursor++;
  }
  if (depth !== 0 || text[cursor + 1] !== '(') return null;
  let parenDepth = 0;
  let dest = cursor + 1;
  while (dest < text.length) {
    const ch = text[dest];
    if (ch === '\\') {
      dest += 2;
      continue;
    }
    if (ch === '\n' && text[dest + 1] === '\n') return null;
    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) return dest + 1;
    }
    dest++;
  }
  return null;
}

function skipBareUrl(text: string, index: number): number | null {
  if (!text.startsWith('https://', index) && !text.startsWith('http://', index) && !text.startsWith('mailto:', index))
    return null;
  let cursor = index;
  while (cursor < text.length && !/[\s<>()[\]]/.test(text[cursor] ?? '')) cursor++;
  return cursor;
}

/**
 * Finds `@handle` and `<@U...>` mention candidates in Markdown while skipping fenced code blocks,
 * inline code spans, Markdown links, bare URLs, escaped characters, emails, and scoped packages.
 */
export function scanSlackOutboundMentions(text: string): OutboundMentionSpan[] {
  const spans: OutboundMentionSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const fencedEnd = skipFencedCodeBlock(text, i);
    if (fencedEnd !== null) {
      i = fencedEnd;
      continue;
    }
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const codeEnd = skipInlineCodeSpan(text, i);
      if (codeEnd !== null) {
        i = codeEnd;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const linkEnd = skipMarkdownLink(text, i);
      if (linkEnd !== null) {
        i = linkEnd;
        continue;
      }
      i++;
      continue;
    }
    if (ch === 'h' || ch === 'm') {
      const urlEnd = skipBareUrl(text, i);
      if (urlEnd !== null) {
        i = urlEnd;
        continue;
      }
    }
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      if (close > i + 1) {
        const inner = text.slice(i + 1, close);
        if (inner.startsWith('@') && validSlackUserId(inner.slice(1))) {
          spans.push({ kind: 'userId', start: i, end: close + 1, userId: inner.slice(1) });
          i = close + 1;
          continue;
        }
        if (
          inner.startsWith('http://') ||
          inner.startsWith('https://') ||
          inner.startsWith('mailto:') ||
          inner.startsWith('!') ||
          inner.startsWith('#') ||
          /^[^\s<>]+@[^\s<>]+$/.test(inner)
        ) {
          i = close + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (ch === '@') {
      const prev = i > 0 ? (text[i - 1] ?? '') : '';
      const first = text[i + 1] ?? '';
      if ((!prev || !handleBoundaryBlocked.test(prev)) && handleStart.test(first)) {
        let end = i + 1;
        while (end < text.length && end - (i + 1) < 64 && handleChar.test(text[end] ?? '')) end++;
        const afterRaw = text[end] ?? '';
        if (afterRaw !== '/' && afterRaw !== '@') {
          let trimmedEnd = end;
          while (trimmedEnd > i + 1 && text[trimmedEnd - 1] === '.') trimmedEnd--;
          const handle = text.slice(i + 1, trimmedEnd);
          if (handle && !reservedBroadcasts.has(handle.toLowerCase())) {
            spans.push({ kind: 'handle', start: i, end: trimmedEnd, handle });
          }
          i = trimmedEnd;
          continue;
        }
        i = end;
        continue;
      }
    }
    i++;
  }
  return spans;
}

export function applySlackOutboundMentions(
  text: string,
  resolution: OutboundMentionResolution,
): ResolvedSlackOutboundMentions {
  const spans = scanSlackOutboundMentions(text);
  const mentionUserIds = new Set<string>();
  if (spans.length === 0) return { text, mentionUserIds };
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.kind === 'userId') {
      if (resolution.knownExternalIds.has(span.userId) && validSlackUserId(span.userId))
        mentionUserIds.add(span.userId);
      continue;
    }
    const target = resolution.byHandle.get(span.handle.toLowerCase());
    if (!target || !validSlackUserId(target.externalId)) continue;
    output += text.slice(cursor, span.start) + `<@${target.externalId}>`;
    mentionUserIds.add(target.externalId);
    cursor = span.end;
  }
  if (cursor === 0) return { text, mentionUserIds };
  output += text.slice(cursor);
  return { text: output, mentionUserIds };
}

export async function resolveSlackOutboundMentions(
  tx: IdentityTransaction,
  teamId: string,
  markdown: string,
): Promise<ResolvedSlackOutboundMentions> {
  const spans = scanSlackOutboundMentions(markdown);
  if (spans.length === 0) return { text: markdown, mentionUserIds: new Set() };
  const handles: string[] = [];
  const targetExternalIds: string[] = [];
  for (const span of spans) {
    if (span.kind === 'handle') handles.push(span.handle);
    else targetExternalIds.push(span.userId);
  }
  const resolution = await resolveOutboundMemberIdentities(tx, {
    targetProvider: 'slack',
    targetScope: teamId,
    handles,
    targetExternalIds,
  });
  return applySlackOutboundMentions(markdown, resolution);
}

function collectFromRichElements(elements: readonly SlackRichElement[], handles: string[], userIds: string[]) {
  for (const element of elements) {
    if (element.type !== 'text' || element.style?.code) continue;
    for (const span of scanSlackOutboundMentions(element.text)) {
      if (span.kind === 'handle') handles.push(span.handle);
      else userIds.push(span.userId);
    }
  }
}

function collectFromRichBlockElements(
  elements: readonly SlackRichBlockElement[],
  handles: string[],
  userIds: string[],
) {
  for (const element of elements) {
    if (element.type === 'rich_text_section' || element.type === 'rich_text_quote')
      collectFromRichElements(element.elements, handles, userIds);
    else if (element.type === 'rich_text_list') {
      for (const section of element.elements) collectFromRichElements(section.elements, handles, userIds);
    }
  }
}

function rewriteRichElements(
  elements: readonly SlackRichElement[],
  resolution: OutboundMentionResolution,
): { elements: SlackRichElement[]; changed: boolean } {
  let changed = false;
  const output: SlackRichElement[] = [];
  for (const element of elements) {
    if (element.type !== 'text' || element.style?.code) {
      output.push(element);
      continue;
    }
    const spans = scanSlackOutboundMentions(element.text);
    if (spans.length === 0) {
      output.push(element);
      continue;
    }
    const styled = element.style ? { style: element.style } : {};
    let cursor = 0;
    let elementChanged = false;
    const pieces: RichTextElement[] = [];
    for (const span of spans) {
      let userId: string | null = null;
      if (span.kind === 'userId') {
        if (resolution.knownExternalIds.has(span.userId) && validSlackUserId(span.userId)) userId = span.userId;
      } else {
        const target = resolution.byHandle.get(span.handle.toLowerCase());
        if (target && validSlackUserId(target.externalId)) userId = target.externalId;
      }
      if (!userId) continue;
      if (span.start > cursor) pieces.push({ type: 'text', text: element.text.slice(cursor, span.start), ...styled });
      pieces.push({ type: 'user', user_id: userId, ...styled });
      cursor = span.end;
      elementChanged = true;
    }
    if (!elementChanged) {
      output.push(element);
      continue;
    }
    if (cursor < element.text.length) pieces.push({ type: 'text', text: element.text.slice(cursor), ...styled });
    output.push(...pieces);
    changed = true;
  }
  return { elements: changed ? output : [...elements], changed };
}

function rewriteBlock(
  block: SlackBlock,
  resolution: OutboundMentionResolution,
): { block: SlackBlock; changed: boolean } {
  switch (block.type) {
    case 'markdown': {
      const next = applySlackOutboundMentions(block.text, resolution);
      return next.text === block.text
        ? { block, changed: false }
        : { block: { ...block, text: next.text }, changed: true };
    }
    case 'section': {
      let changed = false;
      let text = block.text;
      if (text?.type === 'mrkdwn') {
        const next = applySlackOutboundMentions(text.text, resolution);
        if (next.text !== text.text) {
          text = { ...text, text: next.text };
          changed = true;
        }
      }
      let fields = block.fields;
      if (fields?.length) {
        const nextFields = fields.map(field => {
          if (field.type !== 'mrkdwn') return field;
          const next = applySlackOutboundMentions(field.text, resolution);
          if (next.text === field.text) return field;
          changed = true;
          return { ...field, text: next.text };
        });
        if (changed) fields = nextFields;
      }
      return changed
        ? { block: { ...block, ...(text ? { text } : {}), ...(fields ? { fields } : {}) }, changed: true }
        : { block, changed: false };
    }
    case 'context': {
      let changed = false;
      const elements = block.elements.map(element => {
        if (element.type !== 'mrkdwn') return element;
        const next = applySlackOutboundMentions(element.text, resolution);
        if (next.text === element.text) return element;
        changed = true;
        return { ...element, text: next.text };
      });
      return changed ? { block: { ...block, elements }, changed: true } : { block, changed: false };
    }
    case 'rich_text': {
      let changed = false;
      const elements = block.elements.map(element => {
        if (element.type === 'rich_text_section' || element.type === 'rich_text_quote') {
          const next = rewriteRichElements(element.elements, resolution);
          if (!next.changed) return element;
          changed = true;
          return { ...element, elements: next.elements };
        }
        if (element.type === 'rich_text_list') {
          let listChanged = false;
          const sections = element.elements.map(section => {
            const next = rewriteRichElements(section.elements, resolution);
            if (!next.changed) return section;
            listChanged = true;
            return { ...section, elements: next.elements };
          });
          if (!listChanged) return element;
          changed = true;
          return { ...element, elements: sections };
        }
        return element;
      });
      return changed ? { block: { ...block, elements }, changed: true } : { block, changed: false };
    }
    default:
      return { block, changed: false };
  }
}

export async function resolveSlackPresentationMentions(
  tx: IdentityTransaction,
  teamId: string,
  presentation: SlackMessage,
): Promise<SlackMessage> {
  const handles: string[] = [];
  const userIds: string[] = [];
  const collectText = (value: string) => {
    for (const span of scanSlackOutboundMentions(value)) {
      if (span.kind === 'handle') handles.push(span.handle);
      else userIds.push(span.userId);
    }
  };
  collectText(presentation.text);
  for (const block of presentation.blocks) {
    if (block.type === 'markdown') collectText(block.text);
    else if (block.type === 'section') {
      if (block.text?.type === 'mrkdwn') collectText(block.text.text);
      for (const field of block.fields ?? []) if (field.type === 'mrkdwn') collectText(field.text);
    } else if (block.type === 'context') {
      for (const element of block.elements) if (element.type === 'mrkdwn') collectText(element.text);
    } else if (block.type === 'rich_text') {
      collectFromRichBlockElements(block.elements, handles, userIds);
    }
  }
  if (handles.length === 0 && userIds.length === 0) return presentation;
  const resolution = await resolveOutboundMemberIdentities(tx, {
    targetProvider: 'slack',
    targetScope: teamId,
    handles,
    targetExternalIds: userIds,
  });
  if (resolution.byHandle.size === 0 && resolution.knownExternalIds.size === 0) return presentation;
  const nextText = applySlackOutboundMentions(presentation.text, resolution).text;
  let changed = nextText !== presentation.text;
  const nextBlocks = presentation.blocks.map(block => {
    const rewritten = rewriteBlock(block, resolution);
    if (rewritten.changed) changed = true;
    return rewritten.block;
  });
  if (!changed) return presentation;
  const candidate: SlackMessage = { ...presentation, text: nextText, blocks: nextBlocks };
  try {
    return parseSlackSurface(candidate) as SlackMessage;
  } catch {
    return presentation;
  }
}
