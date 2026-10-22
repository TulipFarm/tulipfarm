import type { Definition } from '@tulipfarm/workflows/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { workflowSources } from './provider-sources';
import { useWorkflowProviders } from './queries';

type HttpStep = Extract<Definition['steps'][number], { kind: 'http' }>;
const sourceTitle = (provider: string) =>
  workflowSources.find(item => item.source.provider === provider)?.title ?? provider;

/** Chooses a connected source whose saved secret the request sends in one header. The secret never enters the definition. */
export function HttpCredential({
  workspaceId,
  step,
  disabled,
  onChange,
}: {
  workspaceId: string;
  step: HttpStep;
  disabled: boolean;
  onChange: (credential: HttpStep['credential']) => void;
}) {
  const read = useWorkflowProviders(workspaceId);
  const usable =
    read.state.kind === 'ready'
      ? read.state.data.filter(
          integration => integration.capabilities.use && integration.enabled && integration.authorized,
        )
      : [];
  const chosen = step.credential?.integrationId ?? '';
  const selected = usable.find(integration => integration.id === chosen);
  const control =
    read.state.kind === 'loading' ? (
      <p role="status" className="text-sm text-muted-foreground">
        Loading integrations…
      </p>
    ) : read.state.kind !== 'ready' ? (
      <div className="grid justify-items-start gap-2">
        <p role="alert" className="text-sm">
          Integrations could not load.
        </p>
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry integrations
        </Button>
      </div>
    ) : (
      <Select
        value={chosen}
        disabled={disabled}
        onValueChange={value =>
          onChange(value ? { integrationId: value, header: step.credential?.header ?? 'x-api-key' } : undefined)
        }
      >
        <SelectTrigger id={`http-credential-${step.id}`}>
          <SelectValue>
            {selected
              ? `${selected.name} · ${sourceTitle(selected.source.provider)}`
              : chosen
                ? 'Unavailable integration'
                : 'No credential'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">No credential</SelectItem>
          {usable.map(integration => (
            <SelectItem key={integration.id} value={integration.id}>
              {integration.name} · {sourceTitle(integration.source.provider)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  const helper =
    read.state.kind === 'ready' && !usable.length
      ? 'No enabled connected sources are shared with you for use. Add or share one under connected app sources.'
      : 'Sends the integration’s saved secret in a request header. The secret is never saved in the workflow.';
  return (
    <>
      <Field
        id={`http-credential-${step.id}`}
        label="Credential"
        optional
        helper={helper}
        disabled={disabled}
        error={
          chosen && read.state.kind === 'ready' && !selected
            ? 'This integration is unavailable to you, disabled, or not authorized. Choose another or remove the credential.'
            : undefined
        }
      >
        {control}
      </Field>
      {step.credential && (
        <Field
          id={`http-credential-header-${step.id}`}
          label="Credential header"
          required
          helper="Use lowercase letters, numbers, and hyphens, such as x-api-key."
          disabled={disabled}
        >
          <Input
            value={step.credential.header}
            onChange={event =>
              onChange({
                integrationId: step.credential!.integrationId,
                header: event.target.value.trim().toLowerCase(),
              })
            }
          />
        </Field>
      )}
    </>
  );
}
