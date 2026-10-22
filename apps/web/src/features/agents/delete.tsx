import { useState } from 'react';
import { ActionButton } from '@/components/action-button';
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
    <FormSection title="Delete agent" description="Removes the agent and stops its active versions.">
      <ActionButton
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
      </ActionButton>
      <WriteFeedback
        state={write.state}
        checkStatus={() => void refresh()}
        retry={agentId => void write.submit(agentId)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this saved agent?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes it from accessible lists and revokes its activations.
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
