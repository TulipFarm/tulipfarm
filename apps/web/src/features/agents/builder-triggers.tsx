import { Link } from '@tanstack/react-router';
import { Trash2, Workflow } from 'lucide-react';
import { unattendedTrigger, type AgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { FormSection } from '@tulipfarm/sprout/form';
import { TriggerIcon } from '@/features/workflows/workflow-summary';
import { useSetupTriggerNames } from './setup-review';

export type BuilderTrigger = AgentSetup['triggers'][number];

export function BuilderTriggers({
  workspaceId,
  slug,
  value,
  prompt,
  onChange,
  disabled,
}: {
  workspaceId: string;
  slug: string;
  value: BuilderTrigger[];
  prompt: string | undefined;
  onChange: (value: BuilderTrigger[]) => void;
  disabled: boolean;
}) {
  const name = useSetupTriggerNames(workspaceId, value);
  const unattended = value.some(item => unattendedTrigger(item.trigger));
  return (
    <FormSection
      title="Triggers"
      description="Activating saves these triggers to this agent's workflow. To add a trigger, ask in chat."
      meta={value.length ? `${value.length} added` : undefined}
    >
      {!value.length && (
        <div className="flex items-start gap-3 text-sm">
          <Workflow aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">No triggers. People can still use this agent in chat and Slack.</p>
        </div>
      )}
      <p className="text-sm">
        <Button
          variant="link"
          size="sm"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/workflows" params={{ workspaceSlug: slug }} />}
        >
          Open workflows
        </Button>
      </p>
      {value.map((item, index) => (
        <section key={item.id} aria-label={`Trigger ${index + 1}`} className="flex items-center gap-3 border-t pt-4">
          <TriggerIcon trigger={item.trigger} />
          <h3 className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{name(item)}</h3>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${name(item)}`}
            disabled={disabled}
            onClick={() => onChange(value.filter(other => other.id !== item.id))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </section>
      ))}
      {!!value.length && prompt && (
        <div className="grid gap-1 border-t pt-4 text-sm">
          <p className="font-medium">Task for each run</p>
          <p className="whitespace-pre-wrap wrap-anywhere">{prompt}</p>
        </div>
      )}
      {unattended && (
        <p className="text-sm text-muted-foreground">
          Runs on its own with your current access and creates private tasks.
        </p>
      )}
    </FormSection>
  );
}
