import { useMemo } from 'react';
import type { DefaultKnowledgeIntent } from './default-knowledge-api';
import { googleKnowledgeApi } from './google-knowledge-api';
import { GoogleSelectionForm } from './google-knowledge-selection';
import { slackKnowledgeApi } from './slack-knowledge-api';
import { SlackSelectionForm } from './slack-knowledge-selection';
import { atlassianKnowledgeApi } from './atlassian-knowledge-api';
import { AtlassianSelectionForm } from './atlassian-knowledge-selection';

export function DefaultKnowledgeSelection({
  workspaceId,
  intent,
  onSaved,
  onClose,
}: {
  workspaceId: string;
  intent: DefaultKnowledgeIntent;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const google = useMemo(() => googleKnowledgeApi(workspaceId), [workspaceId]);
  const slack = useMemo(() => slackKnowledgeApi(workspaceId), [workspaceId]);
  const atlassian = useMemo(
    () => atlassianKnowledgeApi(workspaceId, intent.accountKey),
    [workspaceId, intent.accountKey],
  );
  if (intent.product === 'google-drive' || intent.product === 'gmail')
    return (
      <GoogleSelectionForm
        accountId={intent.accountKey}
        onSaved={onSaved}
        onClose={onClose}
        api={google}
        kinds={intent.product === 'gmail' ? ['gmail'] : ['drive-folder', 'shared-drive']}
      />
    );
  if (intent.product === 'slack')
    return <SlackSelectionForm accountId={intent.accountKey} onSaved={onSaved} onClose={onClose} api={slack} />;
  if (intent.product === 'jira' || intent.product === 'confluence')
    return (
      <AtlassianSelectionForm
        accountId={intent.accountKey}
        onSaved={onSaved}
        onClose={onClose}
        api={atlassian}
        product={intent.product}
      />
    );
  return null;
}
