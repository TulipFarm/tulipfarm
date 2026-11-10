import { useRef } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@tulipfarm/sprout/alert-dialog';
import { ScopeSummary } from './reference-names';
import { toolLabels } from './labels';
import type { AgentDetail } from './api';
import { DraftSkill } from './setup-review';

export function RevisionReview({
  workspaceId,
  definition,
  scopes,
  confirm,
  close,
  saved,
}: {
  workspaceId: string;
  definition: AgentDetail['definition'] | null;
  scopes: AgentDetail['activations'][number]['scope'][];
  confirm: () => void;
  close: () => void;
  saved: boolean;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <AlertDialog open={definition !== null} onOpenChange={open => !open && close()}>
      <AlertDialogContent
        initialFocus={title}
        finalFocus={() =>
          document.querySelector<HTMLElement>('#agent-definition-form button[type="submit"]:last-child')
        }
      >
        <AlertDialogTitle ref={title} tabIndex={-1}>
          Review new access before activating
        </AlertDialogTitle>
        <AlertDialogDescription>
          This version changes what {definition?.name} can use or do. Check each change, then activate.
        </AlertDialogDescription>
        {definition && (
          <div className="grid gap-3 text-sm">
            <p className="font-medium">{definition.name}</p>
            <p>Permitted actions: {definition.tools.map(tool => toolLabels[tool]).join(', ') || 'None'}</p>
            {!!definition.skills?.length && (
              <div>
                <p>Skills</p>
                <ul>
                  {definition.skills.map(skill => (
                    <DraftSkill key={skill.id} workspaceId={workspaceId} id={skill.id} />
                  ))}
                </ul>
              </div>
            )}
            {!!definition.mcp?.length && (
              <div>
                <p>MCP tools</p>
                <ul>
                  {definition.mcp.flatMap(slot =>
                    slot.tools.map(tool => <li key={`${slot.id}/${tool.name}`}>{tool.name}</li>),
                  )}
                </ul>
              </div>
            )}
            <p>Model preference: {definition.modelFamilyId ?? 'No saved preference'}</p>
            <p>
              Slack trigger: {definition.responseRule === 'every-message' ? 'Every channel message' : 'When tagged'}
            </p>
            <ul className="grid gap-2">
              {scopes.map((scope, index) => (
                <li key={index}>
                  <ScopeSummary workspaceId={workspaceId} scope={scope} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>
            {saved ? 'Activate this version' : 'Save and activate'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
