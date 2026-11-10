import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@tulipfarm/sprout/input-group';
import { onboardingDetailsSchema } from '@tulipfarm/workspaces/onboarding-contracts';
import { newOnboardingToken, saveOnboarding, workspaceUrlAvailable } from '@/lib/onboarding';
import { suggestWorkspaceSlug, workspaceSlugError } from '@/lib/workspace-slug';

// New workspaces are always business workspaces; the signup flow does not ask.
const accountType = 'business';
const workspaceDraftKey = 'tulipfarm:signup-workspace';
const workspaceDraftSchema = z.object({
  name: z.string().max(80),
  customSlug: z.string().max(48).nullable(),
  expiresAt: z.number(),
});

function readWorkspaceDraft() {
  try {
    const parsed = workspaceDraftSchema.safeParse(JSON.parse(sessionStorage.getItem(workspaceDraftKey) ?? 'null'));
    if (parsed.success && parsed.data.expiresAt > Date.now()) return parsed.data;
  } catch {}
  return null;
}

function clearWorkspaceDraft() {
  try {
    sessionStorage.removeItem(workspaceDraftKey);
  } catch {}
}

export function useOnboardingFields(disabled: boolean) {
  const [draft] = useState(readWorkspaceDraft);
  const [name, setName] = useState(draft?.name ?? '');
  const [customSlug, setCustomSlug] = useState<string | null>(draft?.customSlug ?? null);
  const [submitted, setSubmitted] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<{ slug: string; message: string } | null>(null);
  const checking = useRef<{ slug: string; promise: Promise<boolean> } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saved = useRef<{ details: string; token: string; expiresAt: number | null } | null>(null);
  const slug = customSlug ?? suggestWorkspaceSlug(name);
  const currentSlug = useRef(slug);
  currentSlug.current = slug;
  useEffect(() => {
    try {
      if (!name && customSlug === null) clearWorkspaceDraft();
      else
        sessionStorage.setItem(
          workspaceDraftKey,
          JSON.stringify({ name, customSlug, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }),
        );
    } catch {}
  }, [name, customSlug]);
  const checkAvailability = useCallback((value: string) => {
    clearTimeout(debounce.current);
    if (checking.current?.slug === value) return checking.current.promise;
    const promise = workspaceUrlAvailable(value)
      .then(available => {
        if (currentSlug.current === value)
          setAvailabilityError(available ? null : { slug: value, message: 'This workspace URL is already taken.' });
        return available;
      })
      .catch(() => {
        if (currentSlug.current === value)
          setAvailabilityError({
            slug: value,
            message: 'Could not check this URL. Check your connection and select Continue to try again.',
          });
        return false;
      })
      .finally(() => {
        if (checking.current?.promise === promise) checking.current = null;
      });
    checking.current = { slug: value, promise };
    return promise;
  }, []);
  useEffect(() => {
    if (workspaceSlugError(slug)) return;
    debounce.current = setTimeout(() => void checkAvailability(slug), 400);
    return () => clearTimeout(debounce.current);
  }, [slug, checkAvailability]);
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
    clearWorkspaceDraft();
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
        error={
          (submitted && (customSlug !== null || name.trim()) ? workspaceSlugError(slug) : undefined) ??
          (availabilityError?.slug === slug ? availabilityError.message : undefined)
        }
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
  return {
    fields,
    prepare,
    validate,
    checkAvailability: () => checkAvailability(slug),
    details: { name: name.trim(), slug },
  };
}
