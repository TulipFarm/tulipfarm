import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup, Field, FieldsDisabled } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { workspaceRoute } from '@/router';
import { appSlugPattern, failureMessage, type AppKind } from './api';
import { useAppApi, useAppChanges } from './queries';

const kindOptions = [
  {
    value: 'private',
    label: 'Private',
    description: 'Opens inside TulipFarm. Only people in this workspace you share it with can open it.',
  },
  {
    value: 'public',
    label: 'Public',
    description:
      'Gets its own web address that anyone can visit. A workspace admin must approve it before it goes live, and it uses workspace credits.',
  },
] as const;

export function slugError(slug: string) {
  if (!slug) return undefined;
  if (slug === 'new') return '“new” is reserved. Choose another address.';
  if (!appSlugPattern.test(slug))
    return 'Use up to 48 lowercase letters, numbers and hyphens. Start and end with a letter or number.';
  return undefined;
}

export function NewAppPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const [kind, setKind] = useState<AppKind>('private');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleError = submitted && !title.trim() ? 'Enter a name.' : undefined;
  const addressError = slugError(slug.trim());
  return (
    <PageContent>
      <PageHeader
        titleId="new-app-heading"
        focusable
        title="New app"
        parent={{ label: 'Apps', link: <Link to="/$workspaceSlug/apps" params={{ workspaceSlug: workspace.slug }} /> }}
      />
      <form
        className="max-w-xl space-y-6"
        noValidate
        onSubmit={async event => {
          event.preventDefault();
          setSubmitted(true);
          if (!title.trim() || addressError || saving) return;
          setSaving(true);
          setFailure(null);
          try {
            const created = await api.create({
              kind,
              title: title.trim(),
              ...(slug.trim() ? { slug: slug.trim() } : {}),
            });
            await changes.app(created.id);
            await navigate({
              to: '/$workspaceSlug/apps/$appSlug',
              params: { workspaceSlug: workspace.slug, appSlug: created.slug },
            });
          } catch (error) {
            setFailure(failureMessage(error, { 'name-taken': 'Another app already uses this TulipFarm address.' }));
            setSaving(false);
          }
        }}
      >
        <FieldsDisabled value={saving}>
          <ChoiceGroup
            type="radio"
            required
            legend="Type"
            helper="You can’t change this after you create the app."
            options={kindOptions}
            value={kind}
            onValueChange={setKind}
          />
          <Field label="Name" required error={titleError} counter={`${title.length} / 120`}>
            <Input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
          </Field>
          <Field
            label="TulipFarm address"
            optional
            helper={`Leave empty to use the name. The app opens at /${workspace.slug}/apps/${slug.trim() || 'your-app'}.`}
            error={addressError}
          >
            <Input value={slug} maxLength={48} onChange={event => setSlug(event.target.value.toLowerCase())} />
          </Field>
        </FieldsDisabled>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={saving} aria-busy={saving}>
          Create app
        </Button>
      </form>
    </PageContent>
  );
}
