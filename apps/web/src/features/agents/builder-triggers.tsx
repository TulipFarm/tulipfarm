import { Link } from '@tanstack/react-router';
import { Trash2, Workflow } from 'lucide-react';
import { unattendedTrigger, type AgentSetup } from '@tulipfarm/agents/setup-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { TriggerIcon } from '@/features/workflows/workflow-summary';
import { setupTriggerLabel } from './setup-review';

export type BuilderTrigger = AgentSetup['triggers'][number] & { sponsorConsent: boolean };

export function BuilderTriggers({
  slug,
  value,
  onChange,
  disabled,
  showErrors,
  activating,
}: {
  slug: string;
  value: BuilderTrigger[];
  onChange: (value: BuilderTrigger[]) => void;
  disabled: boolean;
  showErrors: boolean;
  activating: boolean;
}) {
  return (
    <FormSection
      title="Workflow triggers"
      description="Activating creates one workflow per trigger that runs this agent. To add a trigger, ask in chat or add an agent step to a workflow."
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
        <section key={item.id} aria-label={`Trigger ${index + 1}`} className="grid min-w-0 gap-3 border-t pt-4">
          <div className="flex items-start gap-3">
            <TriggerIcon trigger={item.trigger} />
            <div className="grid min-w-0 flex-1 gap-1 text-sm">
              <h3 className="font-medium">{setupTriggerLabel(item.trigger)}</h3>
              <p className="whitespace-pre-wrap wrap-anywhere">{item.prompt}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove trigger ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(value.filter(other => other.id !== item.id))}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          {unattendedTrigger(item.trigger) && (
            <CheckboxField
              id={`builder-trigger-${item.id}`}
              label="I sponsor this trigger"
              helper="Its runs use your current permissions and create private tasks."
              disabled={disabled}
              checked={item.sponsorConsent}
              error={
                showErrors && activating && !item.sponsorConsent ? 'Sponsor this trigger to activate it.' : undefined
              }
              onCheckedChange={checked =>
                onChange(value.map(other => (other.id === item.id ? { ...other, sponsorConsent: checked } : other)))
              }
            />
          )}
        </section>
      ))}
    </FormSection>
  );
}
