import { useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { FormSection } from '@tulipfarm/sprout/form';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@tulipfarm/sprout/alert-dialog';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import type { agentApi } from './api';

export function AgentDelete({
  api,
  id,
  concealed,
  onDeleted,
  refresh,
}: {
  api: ReturnType<typeof agentApi>;
  id: string;
  concealed: boolean;
  onDeleted: () => void;
  refresh: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const write = useTableWrite((agentId: string) => api.remove(agentId), onDeleted);
  if (concealed) return null;
  return (
    <FormSection
      title="Delete agent"
      description="Removes the agent, stops its active versions and archives its trigger workflows."
    >
      <Button
        variant="destructive"
        pendingLabel="Deleting agent…"
        onClick={() => setConfirming(true)}
        state={
          write.state.kind === 'sending'
            ? { kind: 'busy' }
            : write.state.kind === 'uncertain'
              ? { kind: 'blocked', reason: 'Check whether the agent was deleted before trying again.' }
              : { kind: 'ready' }
        }
      >
        Delete agent
      </Button>
      <WriteFeedback
        state={write.state}
        checkStatus={() => void refresh()}
        retry={agentId => void write.submit(agentId)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this saved agent?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes it from accessible lists, revokes its activations and archives its trigger workflows.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep agent</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void write.submit(id);
              }}
            >
              Delete saved agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormSection>
  );
}

export function AgentArchive({
  api,
  id,
  concealed,
  onArchived,
  refresh,
}: {
  api: ReturnType<typeof agentApi>;
  id: string;
  concealed: boolean;
  onArchived: () => void;
  refresh: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const write = useTableWrite((agentId: string) => api.archive(agentId), onArchived);
  if (concealed) return null;
  return (
    <FormSection
      title="Archive agent"
      description="Hides the agent, stops its active versions and archives its trigger workflows. You can restore it later from Archived agents."
    >
      <Button
        variant="outline"
        pendingLabel="Archiving agent…"
        onClick={() => setConfirming(true)}
        state={
          write.state.kind === 'sending'
            ? { kind: 'busy' }
            : write.state.kind === 'uncertain'
              ? { kind: 'blocked', reason: 'Check whether the agent was archived before trying again.' }
              : { kind: 'ready' }
        }
      >
        Archive agent
      </Button>
      <WriteFeedback
        state={write.state}
        checkStatus={() => void refresh()}
        retry={agentId => void write.submit(agentId)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Archive this agent?</AlertDialogTitle>
          <AlertDialogDescription>
            It leaves the agent list, turns off and ends its activations, and archives its trigger workflows. Its team,
            sharing and history stay. Restoring brings it and its workflows back turned off, ready to activate again.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep agent</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                void write.submit(id);
              }}
            >
              Archive agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormSection>
  );
}
