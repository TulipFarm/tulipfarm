// Converts Atlassian Document Format to Markdown for knowledge publication. Unknown nodes keep their text content.
type Node = { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown; marks?: unknown };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const children = (node: Node): Node[] =>
  Array.isArray(node.content) ? node.content.map(item => record(item) as Node) : [];
const attr = (node: Node, name: string) => record(node.attrs)[name];
const str = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** Escapes text so it cannot open a heading, list, quote or code fence at the start of a line. */
export function escapeMarkdownText(value: string) {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .split('\n')
    .map(line => (/^\s{0,3}(?:#|>|[-+] |\d+[.)] |~~~|=+\s*$|-+\s*$)/.test(line) ? `\\${line.trimStart()}` : line))
    .join('\n');
}
function safeUrl(value: unknown) {
  try {
    const url = new URL(str(value));
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
      ? url.href.replace(/[()\s]/g, encodeURIComponent)
      : null;
  } catch {
    return null;
  }
}
function inline(node: Node): string {
  switch (node.type) {
    case 'text': {
      let text = escapeMarkdownText(str(node.text));
      const marks = Array.isArray(node.marks) ? node.marks.map(mark => record(mark)) : [];
      let link: string | null = null;
      for (const mark of marks) {
        if (mark.type === 'code') text = `\`${str(node.text).replaceAll('`', 'ˋ')}\``;
        else if (mark.type === 'strong') text = `**${text}**`;
        else if (mark.type === 'em') text = `*${text}*`;
        else if (mark.type === 'strike') text = `~~${text}~~`;
        else if (mark.type === 'link') link = safeUrl(record(mark.attrs).href);
      }
      return link ? `[${text}](${link})` : text;
    }
    case 'hardBreak':
      return '  \n';
    case 'mention':
      return `@${escapeMarkdownText(str(attr(node, 'text')).replace(/^@/, '') || str(attr(node, 'id')) || 'user')}`;
    case 'emoji':
      return str(attr(node, 'text')) || str(attr(node, 'shortName'));
    case 'date': {
      const time = Number(attr(node, 'timestamp'));
      return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
    }
    case 'status':
      return `[${escapeMarkdownText(str(attr(node, 'text')))}]`;
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = safeUrl(attr(node, 'url'));
      return url ? `<${url}>` : '';
    }
    case 'placeholder':
      return '';
    default:
      return children(node).map(inline).join('');
  }
}
function block(node: Node, depth = 0): string {
  const content = children(node);
  switch (node.type) {
    case 'doc':
      return blocks(content, depth);
    case 'paragraph':
      return content.map(inline).join('');
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attr(node, 'level')) || 1) + 1);
      return `${'#'.repeat(level)} ${content.map(inline).join('').replaceAll('\n', ' ')}`;
    }
    case 'bulletList':
    case 'orderedList':
      return content
        .map((item, index) => {
          const marker = node.type === 'orderedList' ? `${index + 1}.` : '-';
          const body = blocks(children(item), depth + 1).split('\n');
          return [
            `${'  '.repeat(depth)}${marker} ${body[0] ?? ''}`,
            ...body.slice(1).map(line => (line ? `${'  '.repeat(depth + 1)}${line}` : line)),
          ].join('\n');
        })
        .join('\n');
    case 'taskList':
      return content
        .map(
          item =>
            `${'  '.repeat(depth)}- [${attr(item, 'state') === 'DONE' ? 'x' : ' '}] ${blocks(children(item), depth + 1)}`,
        )
        .join('\n');
    case 'codeBlock': {
      const code = content.map(item => str(item.text)).join('');
      const fence = code.includes('```') ? '~~~~' : '```';
      return `${fence}${str(attr(node, 'language')).replace(/[^a-zA-Z0-9_+-]/g, '')}\n${code}\n${fence}`;
    }
    case 'blockquote':
      return blocks(content, depth)
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
    case 'panel':
    case 'expand':
    case 'nestedExpand':
    case 'layoutSection':
    case 'layoutColumn':
    case 'bodiedExtension': {
      const title = str(attr(node, 'title'));
      return `${title ? `**${escapeMarkdownText(title)}**\n\n` : ''}${blocks(content, depth)}`;
    }
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '_Attachment not imported._';
    case 'table': {
      const rows = content.map(row =>
        children(row).map(cell => blocks(children(cell), 0).replace(/\n+/g, ' ').replaceAll('|', '\\|').trim()),
      );
      const width = Math.max(1, ...rows.map(row => row.length));
      const pad = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
      const [head = [], ...rest] = rows;
      return [pad(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rest.map(pad)].join('\n');
    }
    case 'extension':
    case 'inlineExtension':
      return '';
    default:
      return content.length ? blocks(content, depth) : inline(node);
  }
}
function blocks(nodes: Node[], depth: number) {
  return nodes
    .map(node => block(node, depth))
    .filter(Boolean)
    .join('\n\n');
}

export function adfToMarkdown(value: unknown): string {
  const root = record(value) as Node;
  if (root.type !== 'doc') return '';
  return block(root)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
