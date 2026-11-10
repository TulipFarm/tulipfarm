import { useEffect, useMemo, useRef, useState } from 'react';
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
    speed: family.speed ?? undefined,
    quality: family.quality ?? undefined,
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

const dismissedKey = (workspaceId: string) => `tulipfarm:replaced-model-notice:${workspaceId}`;

function dismissedNotice(workspaceId: string) {
  try {
    return window.localStorage.getItem(dismissedKey(workspaceId));
  } catch {
    return null;
  }
}

export function useChatModels(
  workspaceId: string,
  user: Pick<typeof authClient.$Infer.Session.user, 'lastModelFamilyId'>,
  preferWorkspaceDefault = false,
) {
  const catalog = useModelCatalog(workspaceId);
  const [selected, setSelected] = useState<ComposerModel | null>(null);
  const [preferenceSave, setPreferenceSave] = useState<'idle' | 'saving' | 'error'>('idle');
  // The remembered model the member already acknowledged here, by dismissing the notice, choosing or sending.
  const [acknowledged, setAcknowledged] = useState(() => dismissedNotice(workspaceId));
  const saving = useRef(false);
  const defaultRequested = useRef(false);
  const defaultApplied = useRef(false);
  const { state } = catalog;
  const families = state.kind === 'ready' ? state.data.families : [];
  const saved = user.lastModelFamilyId ?? null;
  useEffect(() => {
    if (preferWorkspaceDefault) defaultRequested.current = true;
    if (state.kind !== 'ready') return;
    const listed = (id: string | null | undefined) => state.data.families.find(family => family.id === id);
    const savedFamily = listed(saved);
    const startDefault = defaultRequested.current && !defaultApplied.current;
    const workspaceDefault =
      state.data.families.find(family => family.id === state.data.defaultChatFamilyId && family.available) ??
      state.data.families.find(family => family.available);
    const first = (!startDefault && savedFamily?.available ? savedFamily : undefined) ?? workspaceDefault;
    setSelected(current => {
      if (!startDefault && current && listed(current.id)?.available) return current;
      const replacement = current ? workspaceDefault : first;
      return replacement ? composerModel(replacement) : null;
    });
    if (startDefault) defaultApplied.current = true;
  }, [state, saved, preferWorkspaceDefault]);
  useEffect(() => setAcknowledged(dismissedNotice(workspaceId)), [workspaceId]);
  const current = families.find(family => family.id === selected?.id);
  const model = state.kind === 'unavailable' ? null : current ? composerModel(current) : selected;
  const ready = state.kind === 'ready';
  const choices = families.map(composerModel).sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
  // The member's remembered model can no longer be used here, so new messages use another one until they choose.
  const savedUnavailable =
    ready && !!saved && saved !== acknowledged && !families.some(family => family.id === saved && family.available);
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
    replacedModel: savedUnavailable && model && !model.disabled && model.id !== saved ? model.label : null,
    usable: ready && !!current?.available,
    select: (id: string) => {
      const family = families.find(item => item.id === id && item.available);
      if (ready && family && !saving.current) {
        setSelected(composerModel(family));
        setAcknowledged(saved);
        void savePreference(id);
      }
    },
    sent: () => {
      setAcknowledged(saved);
    },
    dismissReplacedModel: () => {
      if (!saved) return;
      setAcknowledged(saved);
      try {
        window.localStorage.setItem(dismissedKey(workspaceId), saved);
      } catch {
        /* Storage can be disabled by the browser; the notice then stays hidden until reload. */
      }
    },
  };
}

// quiet hides failures while a chat error is shown, so one backend outage shows one alert.
type ChatModels = ReturnType<typeof useChatModels>;

/** An open chat keeps the model of its latest reply. Picking another one also makes it the default for new chats. */
export function useChatModelFor(models: ChatModels, chatModel: string | null, chatId: string): ChatModels {
  const [picked, setPicked] = useState<{ chatId: string; id: string } | null>(null);
  const families = models.state.kind === 'ready' ? models.state.data.families : [];
  const id = picked?.chatId === chatId ? picked.id : chatModel;
  const family = id ? families.find(item => item.id === id && item.available) : undefined;
  const model = useMemo(() => (family ? composerModel(family) : null), [family]);
  const { select } = models;
  return useMemo(() => {
    const choose = (next: string) => {
      if (models.choices.some(choice => choice.id === next && !choice.disabled)) setPicked({ chatId, id: next });
      select(next);
    };
    return model
      ? { ...models, model, usable: true, replacedModel: null, select: choose }
      : { ...models, select: choose };
  }, [models, model, select, chatId]);
}

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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <p role="status">{replaced}</p>
          <Button size="sm" variant="ghost" onClick={catalog.dismissReplacedModel}>
            Dismiss
          </Button>
        </div>
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
