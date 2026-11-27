import { Marked, type Token, type Tokens } from 'marked';
import { decodeHTMLStrict } from 'entities';
import type { RichTextElement, RichTextText } from '@slack/types';
import type { SlackRichBlockElement, SlackRichElement } from './rich-text.ts';
import type { SlackMessage } from './surfaces.ts';
import { parseSlackSurface } from './validation.ts';

type Style = NonNullable<RichTextText['style']>;
type LinkProjection = 'label' | 'destination';
export type RenderSlackAnswerOptions = {
  /** Slack user IDs explicitly authorized to render as live rich-text user mentions. */
  mentionUserIds?: ReadonlySet<string> | undefined;
};
const slackUserMentionPattern = /<@([UW][A-Z0-9]+)>/g;
const markdownParser = new Marked({
  gfm: true,
  tokenizer: {
    // Slack mentions must not consume the rest of the paragraph as an HTML block.
    html() {
      return undefined;
    },
  },
});

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function plain(elements: SlackRichElement[], links: LinkProjection): string {
  return elements
    .map(element => {
      if (element.type === 'text') return element.text;
      if (element.type === 'user') return `<@${element.user_id}>`;
      if (element.type !== 'link') return '';
      const label = element.text ?? element.url;
      return links === 'destination' && label !== element.url ? `${label} (${element.url})` : label;
    })
    .join('');
}

function textElements(
  raw: string,
  style: Style,
  decodeHtml: boolean,
  mentionUserIds?: ReadonlySet<string>,
): RichTextElement[] {
  const styled = Object.keys(style).length ? { style } : {};
  const decode = (value: string) => (decodeHtml ? decodeHTMLStrict(value) : value);
  if (!mentionUserIds?.size) {
    const text = decode(raw);
    return text ? [{ type: 'text', text, ...styled }] : [];
  }
  const result: RichTextElement[] = [];
  let cursor = 0;
  for (const match of raw.matchAll(slackUserMentionPattern)) {
    const userId = match[1];
    const index = match.index;
    if (!userId || index === undefined || !mentionUserIds.has(userId)) continue;
    if (index > cursor) {
      const before = decode(raw.slice(cursor, index));
      if (before) result.push({ type: 'text', text: before, ...styled });
    }
    result.push({ type: 'user', user_id: userId, ...styled });
    cursor = index + match[0].length;
  }
  if (cursor < raw.length) {
    const tail = decode(raw.slice(cursor));
    if (tail) result.push({ type: 'text', text: tail, ...styled });
  }
  return result;
}

function inline(tokens: Token[] = [], style: Style = {}, mentionUserIds?: ReadonlySet<string>): RichTextElement[] {
  return tokens.flatMap((token): RichTextElement[] => {
    switch (token.type) {
      case 'checkbox':
        return [];
      case 'strong':
        return inline(token.tokens, { ...style, bold: true }, mentionUserIds);
      case 'em':
        return inline(token.tokens, { ...style, italic: true }, mentionUserIds);
      case 'del':
        return inline(token.tokens, { ...style, strike: true }, mentionUserIds);
      case 'codespan':
        return [{ type: 'text', text: token.text, style: { ...style, code: true } }];
      case 'br':
        return [{ type: 'text', text: '\n' }];
      case 'link': {
        const url = safeUrl(decodeHTMLStrict(token.href));
        const text = plain(inline(token.tokens), 'label');
        return url
          ? [{ type: 'link', url, text, ...(Object.keys(style).length ? { style } : {}) }]
          : [{ type: 'text', text }];
      }
      case 'image': {
        const url = safeUrl(decodeHTMLStrict(token.href));
        const text = plain(inline(token.tokens), 'label') || 'Image';
        return url ? [{ type: 'link', url, text }] : [{ type: 'text', text }];
      }
      default: {
        if ('tokens' in token && Array.isArray(token.tokens)) return inline(token.tokens, style, mentionUserIds);
        if (token.type === 'text' && !token.escaped) return textElements(token.raw, style, true, mentionUserIds);
        const text = 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
        return text ? [{ type: 'text', text, ...(Object.keys(style).length ? { style } : {}) }] : [];
      }
    }
  });
}

function isList(token: Token): token is Tokens.List {
  return token.type === 'list' && typeof token.ordered === 'boolean' && Array.isArray(token.items);
}

function list(
  token: Tokens.List,
  indent: number,
  links: LinkProjection,
  mentionUserIds?: ReadonlySet<string>,
): SlackRichBlockElement[] {
  const result: SlackRichBlockElement[] = [];
  let offset = typeof token.start === 'number' ? token.start - 1 : 0;
  for (const item of token.items) {
    const content = blocks(item.tokens, links, indent + 1, mentionUserIds);
    for (const [index, block] of content.entries()) {
      if (index === 0 && block.type === 'rich_text_section') {
        if (item.task) block.elements.unshift({ type: 'text', text: item.checked ? '☑ ' : '☐ ' });
        result.push({
          type: 'rich_text_list',
          style: token.ordered ? 'ordered' : 'bullet',
          indent: Math.min(indent, 8),
          ...(token.ordered ? { offset } : {}),
          elements: [block],
        });
      } else {
        if (index === 0) {
          const marker = `${token.ordered ? `${offset + 1}.` : '•'}${item.task ? (item.checked ? ' ☑' : ' ☐') : ''}`;
          if (block.type === 'rich_text_list') {
            result.push({ type: 'rich_text_section', elements: [{ type: 'text', text: marker }] });
          } else block.elements.unshift({ type: 'text', text: `${marker} ` });
        }
        result.push(block);
      }
    }
    offset++;
  }
  return result;
}

function blocks(
  tokens: Token[] = [],
  links: LinkProjection,
  indent = 0,
  mentionUserIds?: ReadonlySet<string>,
): SlackRichBlockElement[] {
  return tokens.flatMap((token): SlackRichBlockElement[] => {
    switch (token.type) {
      case 'space':
      case 'checkbox':
      case 'def':
        return [];
      case 'code':
        return [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text: token.text || ' ' }] }];
      case 'list':
        return isList(token) ? list(token, indent, links, mentionUserIds) : [];
      case 'blockquote':
        return [
          { type: 'rich_text_quote', elements: [{ type: 'text', text: fallback(blocks(token.tokens, links), links) }] },
        ];
      case 'table':
        return [
          {
            type: 'rich_text_preformatted',
            elements: [
              {
                type: 'text',
                text: [token.header, ...token.rows]
                  .map((row: Tokens.TableCell[]) => row.map(cell => plain(inline(cell.tokens), links)).join(' | '))
                  .join('\n'),
              },
            ],
          },
        ];
      case 'hr':
        return [{ type: 'rich_text_section', elements: [{ type: 'text', text: '────────' }] }];
      default: {
        const elements = inline(
          'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [token],
          token.type === 'heading' ? { bold: true } : {},
          mentionUserIds,
        );
        return elements.length ? [{ type: 'rich_text_section', elements }] : [];
      }
    }
  });
}

function fallback(elements: SlackRichBlockElement[], links: LinkProjection): string {
  return elements
    .map(element =>
      element.type === 'rich_text_list'
        ? element.elements
            .map(
              (section, index) =>
                `${element.style === 'bullet' ? '•' : `${(element.offset ?? 0) + index + 1}.`} ${plain(section.elements, links)}`,
            )
            .join('\n')
        : plain(element.elements, links),
    )
    .join('\n\n');
}

function parseAnswer(
  markdown: string,
  links: LinkProjection,
  mentionUserIds?: ReadonlySet<string>,
): SlackRichBlockElement[] {
  if (!markdown.trim() || Buffer.byteLength(markdown) > 65536) throw new Error('slack-answer-size');
  return blocks(markdownParser.lexer(markdown), links, 0, mentionUserIds);
}

export function renderSlackAnswer(markdown: string, options?: RenderSlackAnswerOptions): SlackMessage {
  const elements = parseAnswer(markdown, 'label', options?.mentionUserIds);
  const message: SlackMessage = {
    kind: 'message',
    text: fallback(elements, 'label'),
    blocks: [{ type: 'rich_text', elements }],
  };
  parseSlackSurface(message);
  return message;
}

export function slackOutboundText(markdown: string): string {
  const text = fallback(parseAnswer(markdown, 'destination'), 'destination');
  if (!text.trim() || text.length > 40000) throw new Error('slack-answer-size');
  return text;
}
