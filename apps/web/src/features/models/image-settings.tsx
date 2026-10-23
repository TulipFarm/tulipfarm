import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField, Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { imageSettingsApi, type ImageSettings, type ImageSettingsCommand } from './image-settings-api';

type Draft = { recognition: string; image: string; generation: boolean };
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; settings: ImageSettings };
type Save =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  | { kind: 'uncertain'; command: ImageSettingsCommand };

const draftOf = (settings: ImageSettings): Draft => ({
  recognition: settings.recognitionFamilyId ?? '',
  image: settings.defaultImageModelId ?? '',
  generation: settings.generationEnabled,
});

/** Workspace image settings: the model that reads images, the default image model and whether generation is on. */
export function ImageSettingsSection({
  workspaceId,
  admin,
  writable,
  accessVersion,
}: {
  workspaceId: string;
  admin: boolean;
  writable: boolean;
  accessVersion: number;
}) {
  const api = useMemo(() => imageSettingsApi(workspaceId), [workspaceId]);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const dirty =
    load.kind === 'ready' && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(load.settings));
  const busy = save.kind === 'sending';
  const receive = useEffectEvent((settings: ImageSettings) => {
    if (load.kind === 'ready' && (dirty || save.kind === 'uncertain' || save.kind === 'conflict')) {
      setLoad({
        kind: 'ready',
        settings: {
          ...load.settings,
          recognitionFamilies: settings.recognitionFamilies,
          imageModels: settings.imageModels,
        },
      });
    } else {
      setLoad({ kind: 'ready', settings });
      setDraft(draftOf(settings));
    }
    setRefreshing(false);
    setReadError(null);
  });
  const failed = useEffectEvent((error: unknown) => {
    const message =
      error instanceof TableRequestError
        ? error.message
        : 'Couldn’t load image settings. Check your connection, then retry.';
    if (load.kind === 'ready' && !(error instanceof TableRequestError && [401, 403, 404].includes(error.status)))
      setReadError(message);
    else setLoad({ kind: 'error', message });
    setRefreshing(false);
  });
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    setRefreshing(true);
    api.read(controller.signal).then(
      settings => {
        if (!controller.signal.aborted) receive(settings);
      },
      error => {
        if (!controller.signal.aborted) failed(error);
      },
    );
    return () => controller.abort();
  }, [api, attempt, accessVersion, busy]);
  useEffect(() => () => active.current?.abort(), []);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const reload = useCallback(() => {
    setSave({ kind: 'idle' });
    setLoad({ kind: 'loading' });
    setDraft(null);
    setAttempt(value => value + 1);
  }, []);

  if (load.kind === 'loading')
    return (
      <section aria-label="Images">
        <p role="status" className="text-sm text-muted-foreground">
          Loading image settings…
        </p>
      </section>
    );
  if (load.kind === 'error')
    return (
      <section aria-label="Images" className="space-y-3">
        <Alert variant="destructive">
          <AlertDescription>{load.message}</AlertDescription>
        </Alert>
        <Button variant="outline" disabled={refreshing} onClick={retry}>
          Retry image settings
        </Button>
      </section>
    );
  const settings = load.settings;
  const recognitionName = (id: string | null) =>
    settings.recognitionFamilies.find(family => family.id === id)?.name ?? id;
  const imageName = (id: string | null) => settings.imageModels.find(image => image.id === id)?.name ?? id;
  // With a saved choice, the effective model is that choice, so the catalog default is not known here.
  const defaultLabel = (saved: string | null, name: string | null) =>
    saved ? 'Catalog default' : name ? `Default (${name})` : 'Default (none available)';
  const recognitionDefault = defaultLabel(
    settings.recognitionFamilyId,
    recognitionName(settings.effective.recognitionFamilyId),
  );
  const imageDefault = defaultLabel(settings.defaultImageModelId, imageName(settings.effective.defaultImageModelId));
  const unavailable = (chosen: string | null, effective: string | null) => chosen !== null && effective === null;
  const refreshFeedback = (
    <>
      {refreshing && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing image settings…
        </p>
      )}
      {readError && (
        <div className="space-y-3">
          <Alert variant="destructive">
            <AlertDescription>
              {readError}
              {dirty && ' Your unsaved choices are retained.'}
            </AlertDescription>
          </Alert>
          <Button variant="outline" disabled={refreshing} onClick={retry}>
            Retry image settings
          </Button>
        </div>
      )}
    </>
  );
  const description =
    'Choose the model that reads attached images and the model that creates images. Applies to every chat and agent in this workspace.';
  if (!admin || !draft)
    return (
      <>
        {refreshFeedback}
        <FormSection title="Images" description={description}>
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="inline text-muted-foreground">Reads images: </dt>
              <dd className="inline">
                {recognitionName(settings.effective.recognitionFamilyId) ?? 'No model available'}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Creates images: </dt>
              <dd className="inline">
                {settings.generationEnabled
                  ? (imageName(settings.effective.defaultImageModelId) ?? 'No model available')
                  : 'Off'}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">Only workspace admins can change image settings.</p>
        </FormSection>
      </>
    );

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    if (save.kind === 'saved' || save.kind === 'rejected') setSave({ kind: 'idle' });
  };
  const command = (): ImageSettingsCommand => ({
    requestId: crypto.randomUUID(),
    expectedRevision: settings.revision,
    recognitionFamilyId: draft.recognition || null,
    defaultImageModelId: draft.image || null,
    generationEnabled: draft.generation,
  });

  async function send(input: ImageSettingsCommand) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setSave({ kind: 'sending' });
    try {
      const receipt = await api.save(input, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (controller.signal.aborted) return;
      setLoad({ kind: 'ready', settings: receipt });
      setDraft(draftOf(receipt));
      setSave({ kind: 'saved' });
    } catch (error) {
      if (controller.signal.aborted && active.current !== controller) return;
      if (error instanceof TableRequestError && error.code === 'image-settings-revision-conflict')
        setSave({ kind: 'conflict' });
      else if (
        error instanceof TableRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        setSave({ kind: 'rejected', message: error.message });
      else setSave({ kind: 'uncertain', command: input });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  return (
    <>
      <UnsavedChanges dirty={dirty} />
      {refreshFeedback}
      <Form
        label="Images"
        disabled={busy || !writable || refreshing || !!readError}
        onSubmit={() => {
          if (busy || !writable || refreshing || readError) return;
          if (!dirty || save.kind === 'conflict') return;
          void send(save.kind === 'uncertain' ? save.command : command());
        }}
      >
        <div className="grid gap-4">
          <FormSection title="Images" description={description}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="image-recognition-model"
                label="Model that reads images"
                optional
                helper="Describes attached images and images inside files for models that can’t read them."
                error={
                  unavailable(settings.recognitionFamilyId, settings.effective.recognitionFamilyId) &&
                  draft.recognition === settings.recognitionFamilyId
                    ? 'This model is unavailable, so images are not read. Choose another.'
                    : undefined
                }
              >
                <Select value={draft.recognition} onValueChange={value => update({ recognition: value ?? '' })}>
                  <SelectTrigger width="full">
                    <SelectValue>
                      {draft.recognition ? recognitionName(draft.recognition) : recognitionDefault}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{recognitionDefault}</SelectItem>
                    {settings.recognitionFamilies.map(family => (
                      <SelectItem key={family.id} value={family.id} disabled={!family.enabled}>
                        {family.name}
                        {family.enabled ? '' : ' (unavailable)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                id="image-default-model"
                label="Default image model"
                optional
                helper="Creates images for models that don’t have their own image model."
                error={
                  unavailable(settings.defaultImageModelId, settings.effective.defaultImageModelId) &&
                  draft.image === settings.defaultImageModelId
                    ? 'This image model is unavailable, so images can’t be created with it. Choose another.'
                    : undefined
                }
              >
                <Select value={draft.image} onValueChange={value => update({ image: value ?? '' })}>
                  <SelectTrigger width="full">
                    <SelectValue>{draft.image ? imageName(draft.image) : imageDefault}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{imageDefault}</SelectItem>
                    {settings.imageModels.map(image => (
                      <SelectItem key={image.id} value={image.id} disabled={!image.enabled}>
                        {image.name}
                        {image.enabled ? '' : ' (unavailable)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <CheckboxField
              id="image-generation"
              label="Create images"
              helper="Lets chats and agents create and edit images. Turning this off doesn’t remove images already created."
              checked={draft.generation}
              onCheckedChange={generation => update({ generation })}
            />
          </FormSection>
          <FormFooter
            dirty={dirty}
            note="A model never switches to another image model on its own."
            submit={{
              label: 'Save image settings',
              pendingLabel: 'Saving image settings…',
              state: busy
                ? { kind: 'busy' }
                : !writable
                  ? { kind: 'blocked', reason: 'Reload the Models page to check your current access first.' }
                  : refreshing
                    ? { kind: 'blocked', reason: 'Wait for image settings to finish refreshing.' }
                    : readError
                      ? { kind: 'blocked', reason: 'Retry image settings before saving.' }
                      : save.kind === 'conflict'
                        ? { kind: 'blocked', reason: 'Reload the latest settings first.' }
                        : { kind: 'ready' },
            }}
            cancel={{
              kind: 'reset',
              label: 'Discard changes',
              onReset: () => {
                setDraft(draftOf(settings));
                setSave({ kind: 'idle' });
              },
            }}
          >
            {save.kind === 'saved' && (
              <p role="status" className="text-sm">
                Image settings saved.
              </p>
            )}
            {save.kind === 'rejected' && (
              <Alert variant="destructive">
                <AlertDescription>{save.message}</AlertDescription>
              </Alert>
            )}
            {save.kind === 'uncertain' && (
              <Alert>
                <AlertDescription>
                  We could not confirm this save. Saving again sends the same change once.
                </AlertDescription>
              </Alert>
            )}
            {save.kind === 'conflict' && (
              <div className="space-y-2">
                <Alert variant="destructive">
                  <AlertDescription>
                    Another admin changed image settings. Reload the latest settings, then save again. Reloading
                    discards your changes here.
                  </AlertDescription>
                </Alert>
                <Button variant="outline" onClick={reload}>
                  Reload latest settings
                </Button>
              </div>
            )}
          </FormFooter>
        </div>
      </Form>
    </>
  );
}
