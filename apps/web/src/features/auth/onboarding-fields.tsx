import { useRef, useState } from 'react';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { onboardingDetailsSchema } from '@tulipfarm/workspaces/onboarding-contracts';
import { newOnboardingToken, saveOnboarding } from '@/lib/onboarding';
import { suggestWorkspaceSlug, workspaceSlugError } from '@/lib/workspace-slug';

export function useOnboardingFields(disabled: boolean) {
  const [name, setName] = useState('');
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<'personal' | 'business'>('business');
  const [submitted, setSubmitted] = useState(false);
  const saved = useRef<{ details: string; token: string; expiresAt: number | null } | null>(null);
  const slug = customSlug ?? suggestWorkspaceSlug(name);
  function validate() {
    setSubmitted(true);
    return onboardingDetailsSchema.safeParse({ name, slug, accountType, messages: [] }).success;
  }
  async function prepare() {
    setSubmitted(true);
    const parsed = onboardingDetailsSchema.safeParse({ name, slug, accountType, messages: [] });
    if (!parsed.success) throw new Error('Enter a workspace name and a valid workspace URL.');
    const details = JSON.stringify(parsed.data);
    if (
      saved.current?.details !== details ||
      (saved.current.expiresAt !== null && saved.current.expiresAt <= Date.now())
    ) {
      saved.current = { details, token: newOnboardingToken(), expiresAt: null };
    }
    if (saved.current.expiresAt === null) {
      const draft = await saveOnboarding(saved.current.token, parsed.data);
      saved.current.expiresAt = Date.parse(draft.expiresAt);
    }
    return `/onboarding#token=${saved.current.token}`;
  }
  const fields = (
    <div className="grid gap-4 lg:gap-3">
      <ChoiceGroup
        type="radio"
        legend="Workspace type"
        required
        layout="columns"
        value={accountType}
        disabled={disabled}
        options={[
          { value: 'personal', label: 'Personal' },
          { value: 'business', label: 'Business' },
        ]}
        onValueChange={value => {
          if (value === 'personal' || value === 'business') setAccountType(value);
        }}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:gap-3">
        <Field
          id="onboarding-workspace-name"
          label="Workspace name"
          required
          disabled={disabled}
          error={submitted && !name.trim() ? 'Enter a workspace name.' : undefined}
        >
          <Input
            name="workspace-name"
            scale="lg"
            autoComplete="organization"
            maxLength={80}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </Field>
        <Field
          id="onboarding-workspace-slug"
          label="Workspace URL"
          required
          disabled={disabled}
          helper="It cannot be changed after creation."
          error={submitted ? workspaceSlugError(slug) : undefined}
        >
          <>
            <Input
              name="workspace-slug"
              scale="lg"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={48}
              value={slug}
              onChange={event => setCustomSlug(event.target.value)}
            />
            <output className="block break-all pt-2 text-sm text-muted-foreground">{`${window.location.origin}/${slug}`}</output>
          </>
        </Field>
      </div>
    </div>
  );
  return { fields, prepare, validate };
}
