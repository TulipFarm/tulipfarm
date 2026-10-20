import { useState } from 'react';
import { useFeatureRead } from '@/lib/query';
import { Button } from '@tulipfarm/sprout/button';
import { DefinitionSharing } from '@/features/agents/sharing';
import { AgentRead } from '@/features/agents/feedback';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback, UnsavedChanges } from '@/features/tables/feedback';
import type { skillApi } from './api';

type Api = ReturnType<typeof skillApi>;
type Sharing = Awaited<ReturnType<Api['sharing']>>;
export function SkillSharing({
  api,
  id,
  workspaceId,
  refresh,
}: {
  api: Api;
  id: string;
  workspaceId: string;
  refresh: () => Promise<void>;
}) {
  const read = useFeatureRead({
    key: ['skills', 'sharing', id],
    load: (signal: AbortSignal) => api.sharing(id, signal),
  });
  return (
    <AgentRead state={read.state} refresh={read.refresh}>
      {sharing => (
        <SharingForm
          key={sharing.version}
          api={api}
          id={id}
          workspaceId={workspaceId}
          sharing={sharing}
          refresh={async () => {
            await read.refresh();
            await refresh();
          }}
        />
      )}
    </AgentRead>
  );
}
function SharingForm({
  api,
  id,
  workspaceId,
  sharing,
  refresh,
}: {
  api: Api;
  id: string;
  workspaceId: string;
  sharing: Sharing;
  refresh: () => Promise<void>;
}) {
  const [people, setPeople] = useState(sharing.personGrants);
  const [teams, setTeams] = useState(sharing.grants);
  const write = useTableWrite(
    (input: Sharing) => api.share(id, input),
    () => {
      void refresh();
    },
  );
  const disabled = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  return (
    <section className="space-y-4 border-t pt-6">
      <UnsavedChanges
        dirty={
          JSON.stringify(people) !== JSON.stringify(sharing.personGrants) ||
          JSON.stringify(teams) !== JSON.stringify(sharing.grants)
        }
      />
      <DefinitionSharing
        workspaceId={workspaceId}
        permissions={['read', 'use', 'manage'] as const}
        people={people}
        teams={teams}
        setPeople={setPeople}
        setTeams={setTeams}
        disabled={disabled}
      />
      <Button
        disabled={disabled}
        aria-busy={write.state.kind === 'sending'}
        onClick={() => void write.submit({ version: sharing.version, personGrants: people, grants: teams })}
      >
        Save sharing
      </Button>
      <WriteFeedback state={write.state} checkStatus={() => void refresh()} />
      {write.state.kind === 'accepted' && <p role="status">Sharing saved.</p>}
    </section>
  );
}
