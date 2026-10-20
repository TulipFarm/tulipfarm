import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Database } from 'reicon-react/icons/Database';
import { Globe } from 'reicon-react/icons/Globe';
import { Plug } from 'reicon-react/icons/Plug';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { Users } from 'reicon-react/icons/Users';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import type { ToolActivityItem } from '@tulipfarm/sprout/tool-activity';
import type { ConversationMessage } from './conversation-api';
import { isInternalTool, toolPresentation } from '@tulipfarm/conversations/tool-activity';
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
  if (tool === 'web.fetch') return <BookOpen size={14} />;
  if (tool.startsWith('web.')) return <Globe size={14} />;
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
  if (tool.presentation) return tool.presentation.label;
  return tool.activity || toolPresentation(tool.tool).label;
}

const problems = {
  blocked: 'Access denied. Ask an administrator to review your permissions.',
  failed: 'Failed or interrupted. Check current rows before sending a new request.',
};

function webDetail(tool: Tool) {
  if (tool.status === 'blocked') return problems.blocked;
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

export function toolActivityItems(tools: Tool[]): ToolActivityItem[] {
  return visibleActivityTools(tools).map(toolActivityItem);
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
    detail: tool.tool.startsWith('web.')
      ? webDetail(tool)
      : status === 'blocked' || status === 'failed'
        ? problems[status]
        : status === 'unknown'
          ? 'The outcome is unconfirmed. Check the action status before requesting it again.'
          : status === 'waiting'
            ? 'Waiting for approval or another action. Review the action details below.'
            : undefined,
    ...(tool.web
      ? { urls: tool.web.urls, failedUrls: tool.web.failedUrls, sources: tool.web.sources, query: tool.web.query }
      : {}),
  };
}
