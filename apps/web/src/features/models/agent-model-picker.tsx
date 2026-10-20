import { useCallback, useMemo } from 'react';
import { Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useModelRule } from './queries';
import { modelApi } from './api';
import { FamilyDetails } from './family-details';
import { ModelRead } from './read';
import { useModelCatalog } from './use-model-catalog';
import { ModelOption } from './model-option';
import { ModelSetupLink, noModelsConfigured } from './model-setup';

export function AgentModelPicker({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const api = useMemo(() => modelApi(workspaceId), [workspaceId]);
  const catalog = useModelCatalog(workspaceId);
  return (
    <FormSection
      title="Model preference"
      label="Agent model preference"
      description="The model this agent asks for first."
    >
      <ModelRead state={catalog.state} refresh={catalog.refresh} label="model catalog">
        {({ families }) => {
          const selected = families.find(family => family.id === value);
          return (
            <div className="grid gap-3">
              {!families.length && (
                <StatePanel
                  kind="empty"
                  title={noModelsConfigured}
                  description="An operator needs to set up a model provider. Any saved preference is retained."
                >
                  <ModelSetupLink size="sm" />
                </StatePanel>
              )}
              <Field
                id="agent-model-family"
                label="Preferred model family"
                optional
                disabled={catalog.state.kind !== 'ready' || catalog.state.refreshing || !!catalog.state.error}
                helper={
                  value && (!selected || !selected.available)
                    ? 'Your saved preference is unavailable and has not been replaced. Choose an available family or clear it.'
                    : 'Leave empty to let the workspace choose.'
                }
              >
                <Select
                  value={value ?? ''}
                  onValueChange={(next, details) => {
                    if (next === null && details.reason === 'none') return;
                    onChange(next || undefined);
                  }}
                >
                  <SelectTrigger id="agent-model-family" width="full">
                    <SelectValue>
                      {selected ? (
                        <ModelOption family={selected} />
                      ) : value ? (
                        `${value} (unavailable)`
                      ) : (
                        'Workspace default'
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Workspace default</SelectItem>
                    {value && !selected && (
                      <SelectItem value={value} disabled>
                        {value} (unavailable)
                      </SelectItem>
                    )}
                    {families.map(family => (
                      <SelectItem key={family.id} value={family.id} disabled={!family.available}>
                        <ModelOption family={family} details />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {selected && <FamilyDetails family={selected} />}
            </div>
          );
        }}
      </ModelRead>
      {value && catalog.state.kind === 'ready' && catalog.state.data.families.some(family => family.id === value) && (
        <InheritedFallback key={`${workspaceId}/${value}`} api={api} source={value} />
      )}
    </FormSection>
  );
}

function InheritedFallback({ api, source }: { api: ReturnType<typeof modelApi>; source: string }) {
  const load = useCallback((signal: AbortSignal) => api.rule(source, signal), [api, source]);
  const read = useModelRule(source, load);
  return (
    <section aria-label="Inherited workspace fallback" className="space-y-1 rounded-lg bg-muted px-3 py-2.5 text-sm">
      <h3 className="font-medium text-foreground">Workspace fallback</h3>
      <ModelRead state={read.state} refresh={read.refresh} label="workspace fallback">
        {rule => (
          <p>
            {rule.targetFamilyId
              ? `Inherited fallback: ${rule.targetFamilyId}.`
              : 'No workspace fallback is configured for this family.'}{' '}
            Rule revision {rule.revision}.
          </p>
        )}
      </ModelRead>
      <p className="text-sm text-muted-foreground">
        Read only here. Workspace admins manage this rule in Settings, Models.
      </p>
    </section>
  );
}
