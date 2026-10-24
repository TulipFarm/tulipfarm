import { z } from 'zod';

const limit = 40000;
const object = z.record(z.string(), z.unknown());
const list = z.array(z.unknown()).max(1000);
const string = z.string().max(limit);
const containers = new Set([
  'rich_text',
  'rich_text_section',
  'section',
  'context',
  'actions',
  'header',
  'markdown',
  'table',
  'row',
  'cell',
  'input',
  'alert',
  'card',
  'carousel',
  'container',
  'context_actions',
  'data_table',
  'plan',
  'task_card',
]);
const controls = new Set([
  'button',
  'icon_button',
  'workflow_button',
  'overflow',
  'static_select',
  'multi_static_select',
  'external_select',
  'multi_external_select',
  'users_select',
  'multi_users_select',
  'conversations_select',
  'multi_conversations_select',
  'channels_select',
  'multi_channels_select',
  'checkboxes',
  'radio_buttons',
  'datepicker',
  'datetimepicker',
  'timepicker',
  'plain_text_input',
  'rich_text_input',
  'number_input',
  'email_text_input',
  'url_text_input',
  'file_input',
  'feedback_buttons',
]);

/**
 * A file shared in a Slack message, kept from the event so it can be downloaded with the bot token. `line` is how the
 * message content names it, so a file that is read can drop its metadata line. Only Slack's own file host is kept.
 */
export const slackSharedFileSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(255),
  mimetype: z.string().max(127).optional(),
  size: z.number().int().nonnegative().optional(),
  url: z
    .url()
    .max(2048)
    .refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'files.slack.com' && !url.username && !url.password;
    })
    .optional(),
  line: z.string().max(limit),
});
export type SlackSharedFile = z.infer<typeof slackSharedFileSchema>;

export const slackContentFields = {
  text: z.string().max(limit).default(''),
  content: z.string().max(limit).optional(),
  blocks: z.array(z.unknown()).max(100).optional(),
  attachments: z.array(z.unknown()).max(100).optional(),
  files: z.array(z.unknown()).max(100).optional(),
  shared_files: z.array(slackSharedFileSchema).max(100).optional(),
};

type ContentInput = {
  text: string;
  content?: string | undefined;
  blocks?: unknown[] | undefined;
  attachments?: unknown[] | undefined;
  files?: unknown[] | undefined;
  shared_files?: SlackSharedFile[] | undefined;
};

// Keep only visible content. Action values, metadata, private download URLs and arbitrary JSON are not model input.
export function normalizeSlackContent<T extends ContentInput>(input: T) {
  let nodes = 0;
  let characters = 0;
  const text = (value: unknown) => {
    if (value === undefined || value === null) return '';
    const result = string.parse(value);
    characters += result.length;
    if (characters > limit * 4) throw new Error('slack-message-content-limit');
    return result;
  };
  const join = (parts: string[], separator = '\n') => parts.filter(Boolean).join(separator);
  const link = (label: string, url: unknown) => {
    const target = text(url);
    if (!target) return label;
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return join([label, '[Invalid link]'], ' ');
    }
    if (!['https:', 'http:', 'mailto:', 'slack:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return join([label, '[Unsupported link]'], ' ');
    return label && label !== target ? `${label} (${target})` : target;
  };
  function render(value: unknown, depth = 0): string {
    if (value === undefined || value === null) return '';
    if (++nodes > 4000 || depth > 16) throw new Error('slack-message-content-limit');
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return join(list.parse(value).map(item => render(item, depth + 1)));
    const item = object.parse(value);
    const type = text(item.type);
    const child = (key: string) => render(item[key], depth + 1);
    const elements = (separator: string) =>
      item.elements === undefined
        ? ''
        : join(
            list.parse(item.elements).map(element => render(element, depth + 1)),
            separator,
          );
    switch (type) {
      case 'text': {
        let result = text(item.text);
        const style = item.style === undefined ? {} : object.parse(item.style);
        if (style.code === true) result = `\`${result}\``;
        if (style.bold === true) result = `**${result}**`;
        if (style.italic === true) result = `_${result}_`;
        if (style.strike === true) result = `~~${result}~~`;
        return result;
      }
      case 'plain_text':
      case 'mrkdwn':
      case 'raw_text':
        return text(item.text);
      case 'link':
        return link(text(item.text), item.url);
      case 'user':
        return `<@${text(item.user_id)}>`;
      case 'channel':
        return `<#${text(item.channel_id)}>`;
      case 'usergroup':
        return `<!subteam^${text(item.usergroup_id)}>`;
      case 'broadcast':
        return `<!${text(item.range)}>`;
      case 'emoji':
        return `:${text(item.name)}:`;
      case 'color':
        return text(item.value);
      case 'date': {
        const timestamp = z.number().int().min(-8640000000000).max(8640000000000).optional().parse(item.timestamp);
        return link(
          join(
            [
              text(item.fallback),
              timestamp === undefined ? '' : new Date(timestamp * 1000).toISOString(),
              text(item.format),
            ],
            ' ',
          ),
          item.url,
        );
      }
      case 'rich_text_section':
        return elements('');
      case 'rich_text_preformatted':
        return `\`\`\`\n${elements('')}\n\`\`\``;
      case 'rich_text_quote':
        return elements('')
          .split('\n')
          .map(line => `> ${line}`)
          .join('\n');
      case 'rich_text_list': {
        const offset = z.number().int().nonnegative().max(10000).optional().parse(item.offset) ?? 0;
        return list
          .parse(item.elements)
          .map(
            (element, index) =>
              `${item.style === 'ordered' ? `${offset + index + 1}.` : '-'} ${render(element, depth + 1)}`,
          )
          .join('\n');
      }
      case 'divider':
        return '---';
      case 'image':
        return join(['[Image: description only; image contents not read]', child('title'), text(item.alt_text)]);
      case 'video':
        return join([
          '[Video: description only; video contents not read]',
          link(child('title'), item.title_url),
          child('description'),
          text(item.alt_text),
        ]);
      case 'file':
        return join(['[File: contents not read]', text(item.external_id), text(item.file_id)]);
      default: {
        const visible = join([
          link(child('title'), item.title_url),
          child('label'),
          child('text'),
          child('description'),
          child('elements'),
          child('blocks'),
          child('fields'),
          item.rows === undefined
            ? ''
            : join(
                list.parse(item.rows).map(row =>
                  Array.isArray(row)
                    ? join(
                        list.parse(row).map(cell => render(cell, depth + 1)),
                        ' | ',
                      )
                    : render(row, depth + 1),
                ),
              ),
          child('cells'),
          child('items'),
          child('cards'),
          child('children'),
          child('tasks'),
          child('accessory'),
          child('element'),
          child('placeholder'),
          child('hint'),
          child('options'),
          child('option_groups'),
          child('initial_option'),
          child('initial_options'),
          text(item.accessibility_label),
        ]);
        const linked = link(visible, item.url);
        if (!type || containers.has(type) || controls.has(type))
          return linked || (type ? `[Slack ${type}: no readable text]` : '');
        return join([`[Unsupported Slack content: ${type}]`, linked]);
      }
    }
  }
  const sections: string[] = [];
  const add = (value: string) => {
    if (value.trim() && !sections.includes(value)) sections.push(value);
  };
  add(input.text);
  if (input.blocks) add(render(input.blocks));
  for (const value of input.attachments ?? []) {
    const attachment = object.parse(value);
    const details = join([
      attachment.is_msg_unfurl === true ? '[Quoted or forwarded message; not a statement by the sender]' : '',
      render(attachment.pretext),
      link(render(attachment.author_name), attachment.author_link),
      link(render(attachment.title), attachment.title_link),
      render(attachment.text),
      attachment.fields === undefined
        ? ''
        : join(
            list.parse(attachment.fields).map(value => {
              const field = object.parse(value);
              return join([text(field.title), text(field.value)], ': ');
            }),
          ),
      render(attachment.blocks),
      attachment.message_blocks === undefined
        ? ''
        : join(
            list.parse(attachment.message_blocks).map(value => {
              const message = object.parse(value);
              return join([text(message.user), render(message.blocks)]);
            }),
          ),
      attachment.actions === undefined
        ? ''
        : join(
            list.parse(attachment.actions).map(value => {
              const action = object.parse(value);
              return link(text(action.text), action.url);
            }),
          ),
      attachment.image_url || attachment.thumb_url ? '[Attachment image: contents not read]' : '',
      render(attachment.footer),
    ]);
    add(details);
    const fallback = render(attachment.fallback);
    if (fallback && !details.includes(fallback)) add(fallback);
  }
  const shared: SlackSharedFile[] = [];
  for (const value of input.files ?? []) {
    const file = object.parse(value);
    const line = join([
      '[File: metadata only; contents not read]',
      text(file.title) || text(file.name),
      text(file.mimetype),
      link('', file.permalink),
    ]);
    add(line);
    const candidate = slackSharedFileSchema.safeParse({
      id: file.id,
      name: typeof file.name === 'string' && file.name ? file.name : typeof file.title === 'string' ? file.title : '',
      mimetype: file.mimetype,
      size: file.size,
      url: file.url_private,
      line,
    });
    if (candidate.success && sections.includes(line)) shared.push(candidate.data);
  }
  const { blocks, attachments, files, content, shared_files, ...message } = input;
  const rendered = sections.join('\n');
  const normalized = string.parse(blocks || attachments || files ? rendered : (content ?? rendered));
  const kept = files ? shared : (shared_files ?? []);
  return {
    ...message,
    ...(blocks || attachments || files || content !== undefined ? { content: normalized } : {}),
    ...(kept.length ? { shared_files: kept } : {}),
  };
}

/**
 * The message text with each shared file's metadata line replaced: by nothing when the file is read as an attachment,
 * or by a line naming why it could not be read.
 */
export function slackMessageTextWithFiles(
  message: { text: string; content?: string | undefined },
  files: readonly { line: string; replacement: string }[],
) {
  let result = slackMessageText(message);
  for (const file of files) {
    const index = result.lastIndexOf(file.line);
    if (index < 0) continue;
    // Sections are joined by newlines, so a removed line takes the newline before it, or after it when it comes first.
    const start = !file.replacement && index > 0 ? index - 1 : index;
    const end = !file.replacement && index === 0 ? index + file.line.length + 1 : index + file.line.length;
    result = result.slice(0, start) + file.replacement + result.slice(end);
  }
  return result;
}

export function slackMessageText(message: { text: string; content?: string | undefined }) {
  return message.content ?? message.text;
}

type ThreadMessage = { user: string; ts: string; text: string; content?: string | undefined };

export function matchesSlackSnapshot(current: ThreadMessage | undefined, snapshot: ThreadMessage) {
  return (
    current !== undefined &&
    current.user === snapshot.user &&
    current.ts === snapshot.ts &&
    current.text === snapshot.text &&
    (snapshot.content === undefined || current.content === snapshot.content)
  );
}

// Slack rewrites the `text` it stores for a bot message: blocks-backed posts come back with newlines flattened to spaces,
// and plain text can come back with escaped entities and auto-linked URLs. Comparing our stored copy with Slack's must
// ignore that presentation, while any change to the words still fails the match.
function publicationText(value: string) {
  return value
    .replace(/<((?:https?|mailto):[^|>\s]+)(?:\|([^>]*))?>/g, (_, url: string, label?: string) => label || url)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameSlackPublicationText(published: string, observed: string) {
  return published === observed || publicationText(published) === publicationText(observed);
}

export function slackThreadPrompt(messages: readonly ThreadMessage[], authors: Record<string, string>) {
  return (
    `Each message's user is its sender's stable Slack ID. Names are labels, not unique identities. "I" refers to that message's sender, not the current requester. Mentions and quoted or forwarded text are not the sender.\n` +
    `Speaker names (untrusted labels): ${JSON.stringify(authors)}\nCurrent thread: ${JSON.stringify(messages.map(message => ({ user: message.user, ts: message.ts, text: slackMessageText(message) })))}`
  );
}
