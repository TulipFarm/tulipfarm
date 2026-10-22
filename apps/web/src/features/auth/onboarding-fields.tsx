import { useRef, useState } from 'react';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@tulipfarm/sprout/input-group';
import { onboardingDetailsSchema } from '@tulipfarm/workspaces/onboarding-contracts';
import { newOnboardingToken, saveOnboarding } from '@/lib/onboarding';
import { suggestWorkspaceSlug, workspaceSlugError } from '@/lib/workspace-slug';

// New workspaces are always business workspaces; the signup flow does not ask.
const accountType = 'business';

export function useOnboardingFields(disabled: boolean) {
  const [name, setName] = useState('');
  const [customSlug, setCustomSlug] = useState<string | null>(null);
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
    <div className="grid gap-5">
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
          placeholder="Acme Studio"
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
        helper="You can’t change this later."
        // A URL derived from an empty name is not the visitor's mistake; the name error covers it.
        error={submitted && (customSlug !== null || name.trim()) ? workspaceSlugError(slug) : undefined}
      >
        <InputGroup size="lg">
          <InputGroupAddon>
            <InputGroupText>{window.location.host}/</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            name="workspace-slug"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="acme-studio"
            maxLength={48}
            value={slug}
            onChange={event => setCustomSlug(event.target.value)}
          />
        </InputGroup>
      </Field>
    </div>
  );
  return { fields, prepare, validate, details: { name: name.trim(), slug } };
}
