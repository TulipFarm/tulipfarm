const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => entities[character] ?? character);
}

const hold = (store: string[], html: string) => `\uE000${store.push(html) - 1}\uE000`;

function emphasis(text: string): string {
  return text.replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(?=\S)([^*]+?)\*/g, '<em>$1</em>');
}

/** Inline markup on already-escaped text: code spans, http(s) links, bold and italic. */
function inline(escaped: string): string {
  const held: string[] = [];
  let text = escaped.replace(/`([^`]+)`/g, (_, code: string) => hold(held, `<code>${code}</code>`));
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label: string, href: string) =>
    hold(held, `<a href="${href}" rel="noopener noreferrer">${emphasis(label)}</a>`),
  );
  return emphasis(text).replace(/\uE000(\d+)\uE000/g, (_, slot: string) => held[Number(slot)] ?? '');
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'h'; lines: string[] };

/**
 * Renders the small Markdown subset section text may use. All input is escaped before any markup is added, so the
 * output never contains HTML from the text itself.
 */
export function renderMarkdown(source: string): string {
  const blocks: Block[] = [];
  for (const raw of escapeHtml(source.replace(/\uE000/g, '')).split(/\r?\n/)) {
    const line = raw.trim();
    // Headings would compete with the document's own sections, so they become a bold lead-in line.
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', lines: [heading[1] ?? ''] }, { kind: 'p', lines: [] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
    const kind = !line ? null : bullet ? 'ul' : numbered ? 'ol' : 'p';
    const last = blocks.at(-1);
    if (!kind) {
      blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    const content = bullet?.[1] ?? numbered?.[1] ?? line;
    if (last && last.kind === kind && (kind !== 'p' || last.lines.length)) last.lines.push(content);
    else if (last && last.kind === 'p' && !last.lines.length) {
      last.kind = kind;
      last.lines.push(content);
    } else blocks.push({ kind, lines: [content] });
  }
  return blocks
    .filter(block => block.lines.length)
    .map(block =>
      block.kind === 'h'
        ? `<p class="lead-in"><strong>${inline(block.lines.join(' '))}</strong></p>`
        : block.kind === 'p'
          ? `<p>${block.lines.map(inline).join(' ')}</p>`
          : `<${block.kind}>${block.lines.map(line => `<li>${inline(line)}</li>`).join('')}</${block.kind}>`,
    )
    .join('\n');
}
