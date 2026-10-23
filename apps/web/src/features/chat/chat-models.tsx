import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { Button } from '@tulipfarm/sprout/button';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { authClient } from '@/lib/auth';
import type { ComposerModel } from './composer';
import { familyCost } from '@/features/models/family-cost';
import { modelBrand } from '@/features/models/model-brand';
import { modelLogo } from '@/features/models/model-logo';
import { ModelSetupLink, noModelsConfigured } from '@/features/models/model-setup';

function composerModel(family: ModelCatalogFamily): ComposerModel {
  return {
    id: family.id,
    label: family.displayName,
    logo: modelLogo(family.vendor),
    brand: modelBrand(family.vendor),
    cost: familyCost(family),
    disabled: !family.available,
    ...(!family.available
      ? {
          unavailableReason:
            family.unavailableReason === 'model-family-paused' ? 'temporarily unavailable' : 'disabled in workspace',
        }
      : {}),
  };
}

export function useChatModels(
  workspaceId: string,
  user: Pick<typeof authClient.$Infer.Session.user, 'lastModelFamilyId'>,
) {
  const catalog = useModelCatalog(workspaceId);
  const [selected, setSelected] = useState<ComposerModel | null>(null);
  const [preferenceSave, setPreferenceSave] = useState<'idle' | 'saving' | 'error'>('idle');
  const saving = useRef(false);
  const { state } = catalog;
  const families = state.kind === 'ready' ? state.data.families : [];
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const saved = user.lastModelFamilyId;
    const listed = (id: string | null | undefined) => state.data.families.find(family => family.id === id);
    const savedFamily = listed(saved);
    const first =
      (savedFamily?.unavailableReason === 'model-family-paused' ? undefined : savedFamily) ??
      state.data.families.find(family => family.id === state.data.defaultChatFamilyId && family.available) ??
      state.data.families.find(family => family.available);
    setSelected(current => (current && listed(current.id) ? current : first ? composerModel(first) : null));
  }, [state, user.lastModelFamilyId]);
  const current = families.find(family => family.id === selected?.id);
  const model = state.kind === 'unavailable' ? null : current ? composerModel(current) : selected;
  const ready = state.kind === 'ready';
  const choices = families.map(composerModel).sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
  // The operator removed the person's saved model, so new messages use another one until they choose.
  const savedRemoved =
    ready && !!user.lastModelFamilyId && !families.some(family => family.id === user.lastModelFamilyId);
  async function savePreference(id: string) {
    if (saving.current) return;
    saving.current = true;
    setPreferenceSave('saving');
    try {
      const result = await authClient.updateUser({ lastModelFamilyId: id }, { signal: AbortSignal.timeout(15_000) });
      setPreferenceSave(result.error ? 'error' : 'idle');
    } catch {
      setPreferenceSave('error');
    } finally {
      saving.current = false;
    }
  }
  return {
    ...catalog,
    model,
    preferenceSave,
    retryPreference: () => {
      if (selected) void savePreference(selected.id);
    },
    choices: ready && preferenceSave !== 'saving' ? choices : [],
    replacedModel: savedRemoved && model && !model.disabled ? model.label : null,
    usable: ready && !!current?.available,
    select: (id: string) => {
      const family = families.find(item => item.id === id && item.available);
      if (ready && family && !saving.current) {
        setSelected(composerModel(family));
        void savePreference(id);
      }
    },
  };
}

// quiet hides failures while a chat error is shown, so one backend outage shows one alert.
export function ChatModelStatus({
  catalog,
  slug,
  quiet = false,
}: {
  catalog: ReturnType<typeof useChatModels>;
  slug: string;
  quiet?: boolean;
}) {
  const { state, model } = catalog;
  const busy = state.kind === 'loading' || (state.kind === 'ready' && state.refreshing);
  const failed = state.kind === 'error' || (state.kind === 'ready' && !!state.error);
  const family = state.kind === 'ready' ? state.data.families.find(item => item.id === model?.id) : undefined;
  const empty = state.kind === 'ready' && !state.data.families.length;
  const message = busy
    ? 'Checking available models…'
    : failed
      ? quiet
        ? null
        : 'Could not check model availability. Try again.'
      : state.kind === 'unavailable'
        ? 'Model access is unavailable. Ask a workspace admin.'
        : family && !family.available
          ? family.unavailableReason === 'model-family-paused'
            ? `${family.displayName} is temporarily unavailable. Choose another model.`
            : `${family.displayName} is disabled in this workspace. Choose another model.`
          : empty
            ? `${noModelsConfigured}. An operator needs to set up a model provider.`
            : state.kind === 'ready' && !state.data.families.some(item => item.available)
              ? 'No models are available. Ask a workspace admin.'
              : null;
  const replaced =
    !message && catalog.replacedModel
      ? `Your last model is no longer available. New messages use ${catalog.replacedModel}.`
      : null;
  return (
    <>
      {replaced && (
        <p role="status" className="text-sm text-muted-foreground">
          {replaced}
        </p>
      )}
      {message && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <p role={failed ? 'alert' : 'status'}>{message}</p>
          {!busy && (
            <>
              <Button size="sm" variant="outline" onClick={() => void catalog.refresh()}>
                Retry models
              </Button>
              {empty && <ModelSetupLink />}
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug: slug }} />}
              >
                Model access
              </Button>
            </>
          )}
        </div>
      )}
      {catalog.preferenceSave === 'saving' && (
        <p role="status" className="text-sm text-muted-foreground">
          Saving your default model…
        </p>
      )}
      {catalog.preferenceSave === 'error' && !failed && !quiet && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <p role="alert">Could not save your default model. Your selection works for this chat.</p>
          <Button size="sm" variant="outline" onClick={catalog.retryPreference}>
            Retry saving default
          </Button>
        </div>
      )}
    </>
  );
}
