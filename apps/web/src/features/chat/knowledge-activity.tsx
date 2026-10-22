import type { KnowledgeActivity } from '@tulipfarm/conversations/knowledge-activity';
import type { ReactNode } from 'react';
import type { ToolActivityItem } from '@tulipfarm/sprout/tool-activity';
import type { ConversationMessage } from './conversation-api';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';

const knowledgeOutcomeLabels: Record<KnowledgeActivity['status'], string> = {
  running: 'Reading knowledge sources',
  success: 'Read knowledge sources',
  partial: 'Read partial knowledge evidence',
  empty: 'No new knowledge evidence',
  unavailable: 'Knowledge source unavailable',
  failed: 'Knowledge retrieval failed',
  exhausted: 'Knowledge search limit reached',
  waiting: 'Waiting for the current knowledge round',
};
const knowledgeOutcomeDetails: Partial<Record<KnowledgeActivity['status'], string>> = {
  partial: 'Some sections or branches are missing. Open Details to see what was returned.',
  empty: 'No new passages were returned. Use earlier evidence or name the source in a new message.',
  unavailable: 'The source is no longer available to you. Choose an available source in a new message.',
  failed: 'The read failed. Send a new message to search again.',
  exhausted:
    'This request has no search allowance left. Use the evidence already returned, or ask to go deeper in a new message.',
  waiting: 'The current round must finish before another round can start.',
};
const branchLabels: Record<KnowledgeActivity['branches'][number]['status'], string> = {
  evidence: 'Evidence returned',
  'no-match': 'No matches',
  unavailable: 'Source unavailable',
  failed: 'Read failed',
};

type Tool = ConversationMessage['tools'][number];

export function knowledgeToolLabel(tool: Tool) {
  const status = tool.activityStatus ?? tool.status;
  if (status === 'cancelled') return 'Knowledge retrieval cancelled';
  if (status === 'blocked') return 'Knowledge access denied';
  if (status === 'failed') return 'Knowledge retrieval failed';
  if (tool.knowledge)
    return tool.knowledge.status === 'running' && tool.knowledge.action === 'search'
      ? 'Searching knowledge'
      : knowledgeOutcomeLabels[tool.knowledge.status];
  return status === 'running' ? 'Reading knowledge sources' : 'Knowledge retrieval';
}

export function knowledgeToolActivityItem(tool: Tool, visual: ReactNode): ToolActivityItem {
  let status = tool.activityStatus ?? tool.status;
  let detail = tool.knowledge ? knowledgeOutcomeDetails[tool.knowledge.status] : undefined;
  if (status === 'cancelled') detail = 'The read was cancelled. No further search was started.';
  else if (status === 'blocked') detail = 'Access denied. Ask an administrator to review your permissions.';
  else if (status === 'failed') detail = knowledgeOutcomeDetails.failed;
  else if (tool.knowledge?.status === 'failed' || tool.knowledge?.status === 'unavailable') status = 'failed';
  else if (tool.knowledge?.status === 'waiting') status = 'waiting';
  return {
    id: tool.id,
    label: knowledgeToolLabel(tool),
    status,
    visual,
    detail,
    ...(tool.knowledge ? { details: <KnowledgeActivityDetails knowledge={tool.knowledge} /> } : {}),
  };
}

function KnowledgeActivityDetails({ knowledge }: { knowledge: KnowledgeActivity }) {
  if (!knowledge.branches.length) return null;
  return (
    <div className="ml-12">
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="link" size="sm" />}>Details</CollapsibleTrigger>
        <CollapsibleContent>
          <ol aria-label="Knowledge branches" className="space-y-2 py-1 text-xs text-muted-foreground">
            {knowledge.branches.map(branch => (
              <li key={branch.index}>
                <p>
                  Branch {branch.index + 1}:{' '}
                  {branch.reason?.endsWith('timeout') ? 'Timed out' : branchLabels[branch.status]}
                </p>
                {branch.documents.map((document, index) => (
                  <p key={index} className="wrap-anywhere">
                    {document.title}: {document.passages} {document.passages === 1 ? 'passage' : 'passages'}.
                    {document.partial ? ' Some sections were not returned.' : ' Full document returned.'}
                  </p>
                ))}
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
