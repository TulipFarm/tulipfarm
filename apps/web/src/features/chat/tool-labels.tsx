import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Database } from 'reicon-react/icons/Database';
import { Globe } from 'reicon-react/icons/Globe';
import { Plug } from 'reicon-react/icons/Plug';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { Users } from 'reicon-react/icons/Users';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import type { ToolActivityItem } from '@tulipfarm/sprout/tool-activity';
import type { ConversationMessage } from './conversation-api';
import { apiCallProblem, isInternalTool, toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { knowledgeToolActivityItem, knowledgeToolLabel } from './knowledge-activity';

type Tool = ConversationMessage['tools'][number];

const googleApps: [RegExp, Brand][] = [
  [/calendar|meeting|event|schedule/i, 'google-calendar'],
  [/sheet|spreadsheet/i, 'google-sheets'],
  [/mail|inbox|email/i, 'gmail'],
  [/slide|presentation/i, 'google-slides'],
  [/form/i, 'google-forms'],
  [/doc/i, 'google-docs'],
  [/drive|file|folder/i, 'google-drive'],
];

function brandOf(tool: string, label: string): Brand | null {
  if (tool.startsWith('google.')) return googleApps.find(([pattern]) => pattern.test(label))?.[1] ?? 'google';
  if (tool.startsWith('slack.')) return 'slack';
  if (tool.startsWith('github.')) return 'github';
  if (tool.startsWith('atlassian.')) return /confluence|page|space/i.test(label) ? 'confluence' : 'jira';
  return null;
}

export function toolVisual(tool: string, brand?: Brand | null) {
  if (brand) return <BrandIcon brand={brand} size="inline" />;
  if (/^(tables|rows|schema)\./.test(tool)) return <Database size={14} />;
  if (tool.startsWith('skills.')) return <BookOpen size={14} />;
  if (tool.startsWith('knowledge.')) return <BookOpen size={14} />;
  if (tool.startsWith('agents.')) return <Users size={14} />;
  if (tool === 'web.fetch' || tool === 'files.read') return <BookOpen size={14} />;
  if (tool.startsWith('web.') || tool === 'api.request') return <Globe size={14} />;
  if (tool.startsWith('mcp.')) return <Plug size={14} />;
  return <Sparkle size={14} />;
}

export function toolLabel(tool: Tool) {
  if (tool.tool === 'knowledge.retrieve') return knowledgeToolLabel(tool);
  if (tool.tool === 'web.search' || tool.tool === 'web.fetch') {
    const search = tool.tool === 'web.search';
    const status = tool.activityStatus ?? tool.status;
    if (status === 'failed' || tool.web?.status === 'failed') return search ? 'Web search failed' : 'Page read failed';
    if (status === 'running') return search ? 'Searching the web' : 'Reading a web page';
    if (status === 'completed') return search ? 'Searched the web' : 'Read a web page';
    return search ? 'Web search' : 'Page read';
  }
  const label = tool.presentation?.label ?? (tool.activity || toolPresentation(tool.tool).label);
  return tool.api && 'httpStatus' in tool.api ? `${label} · ${tool.api.httpStatus}` : label;
}

const problems = {
  failed: 'Failed or interrupted. Check current rows before sending a new request.',
};

const tableAccessStep = 'Ask a workspace admin to grant it to you or your team in Table access, then ask again.';
const rowPermissions: [RegExp, string][] = [
  [/^rows\.create/, 'Create rows'],
  [/^rows\.update/, 'Update rows'],
  [/^rows\.delete/, 'Delete rows'],
  [/^rows\./, 'Read rows'],
];

/** Names the permission a denied step needs and where to get it; the server never says which check failed. */
export function deniedDetail(tool: string) {
  if (tool === 'tables.propose' || tool.startsWith('tables.import.'))
    return `Access denied. This change needs a table permission you don’t have, such as Create tables for the owning team, or Manage schema, Read rows, Create rows, Update rows or Delete rows on the table. ${tableAccessStep}`;
  const rows = rowPermissions.find(([pattern]) => pattern.test(tool))?.[1];
  if (rows) return `Access denied. This step needs ${rows} on the table. ${tableAccessStep}`;
  if (/^(tables|schema)\./.test(tool)) return `Access denied. This step needs access to the table. ${tableAccessStep}`;
  if (tool === 'files.read')
    return 'Access denied. You can’t open this file. Ask its owner to share it with you, then ask again.';
  return 'Access denied. Your role doesn’t allow this step. Ask a workspace admin to give you the access it needs, or ask someone who has it to do it.';
}

function webDetail(tool: Tool) {
  if (tool.status === 'blocked') return deniedDetail(tool.tool);
  const widened = tool.web?.widened ? ' Search widened from 24 hours to seven days.' : '';
  if (tool.status === 'failed' || tool.web?.status === 'failed')
    return `Public web retrieval failed. Retry or paste the text.${widened}`;
  if (tool.web?.status === 'partial')
    return `Some retrieval failed. Available sources are shown; retry for missing coverage.${widened}`;
  if (tool.web?.status === 'empty')
    return tool.tool === 'web.search'
      ? `No usable results. Try a different search.${widened}`
      : 'No page content was returned. Retry or paste the text.';
  return widened.trim() || undefined;
}

export function visibleActivityTools(tools: Tool[]): Tool[] {
  return tools.filter(tool => !tool.tool.startsWith('skills.') || !isInternalTool(tool.tool));
}

const recovered = new Set(['completed', 'waiting']);

/**
 * A denied step that a later call of the same tool in this reply got past is folded into that call,
 * so the reply no longer reads as denied.
 */
export function toolActivityItems(tools: Tool[]): ToolActivityItem[] {
  const visible = visibleActivityTools(tools);
  const items = visible.map(toolActivityItem);
  const retried = new Set<number>();
  const denied = new Set<number>();
  items.forEach((item, index) => {
    if (item.status !== 'blocked') return;
    const retry = items.findIndex(
      (later, at) => at > index && visible[at]?.tool === visible[index]?.tool && recovered.has(later.status),
    );
    if (retry === -1) return;
    denied.add(index);
    retried.add(retry);
  });
  return items.flatMap((item, index) =>
    denied.has(index)
      ? []
      : retried.has(index)
        ? [
            {
              ...item,
              detail: [item.detail, 'An earlier attempt was denied; this one went through.'].filter(Boolean).join(' '),
            },
          ]
        : [item],
  );
}

function toolActivityItem(tool: Tool): ToolActivityItem {
  if (tool.tool === 'knowledge.retrieve') return knowledgeToolActivityItem(tool, toolVisual(tool.tool));
  const label = toolLabel(tool);
  const brand = tool.presentation ? tool.presentation.brand : brandOf(tool.tool, label);
  const status =
    tool.status === 'blocked'
      ? 'blocked'
      : tool.web?.status === 'failed'
        ? 'failed'
        : (tool.activityStatus ?? tool.status);
  return {
    id: tool.id,
    label,
    status,
    visual: toolVisual(tool.tool, brand),
    detail: tool.activityDetail
      ? tool.activityDetail
      : tool.tool.startsWith('web.')
        ? webDetail(tool)
        : tool.tool === 'api.request' && status === 'failed'
          ? apiCallProblem(tool.api && 'error' in tool.api ? tool.api.error : undefined)
          : status === 'blocked'
            ? deniedDetail(tool.tool)
            : status === 'failed'
              ? problems.failed
              : status === 'unknown'
                ? 'The outcome is unconfirmed. Check the action status before requesting it again.'
                : status === 'waiting'
                  ? tool.tool === 'api.request'
                    ? 'Waiting for your approval.'
                    : 'Waiting for approval or another action. Review the action details below.'
                  : undefined,
    ...(tool.web
      ? { urls: tool.web.urls, failedUrls: tool.web.failedUrls, sources: tool.web.sources, query: tool.web.query }
      : {}),
    ...(tool.narration ? { details: <p className="text-sm text-muted-foreground">{tool.narration}</p> } : {}),
  };
}
