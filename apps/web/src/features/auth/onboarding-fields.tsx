import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { EditIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@tulipfarm/sprout/input-group';
import {
  onboardingDetailsSchema,
  onboardingProfileSchema,
  type OnboardingProfile,
} from '@tulipfarm/workspaces/onboarding-contracts';
import { emptyOnboardingProfile } from '@tulipfarm/workspaces/onboarding-interview';
import { newOnboardingToken, saveOnboarding, workspaceUrlAvailable } from '@/lib/onboarding';
import { onboardingChatMessages } from '@/features/auth/onboarding-interview';
import { findWebsite, guideVisitor } from '@/features/auth/guide-visitor';
import { AuthVerification } from '@/features/auth/verification';
import { suggestWorkspaceSlug, workspaceSlugError } from '@/lib/workspace-slug';

// New workspaces are always business workspaces; the signup flow does not ask.
const accountType = 'business';
const workspaceDraftKey = 'tulipfarm:signup-workspace';
const workspaceDraftSchema = z.object({
  name: z.string().max(80),
  customSlug: z.string().max(48).nullable(),
  website: z.string().max(200).default(''),
  personName: z.string().max(80).default(''),
  profile: onboardingProfileSchema.optional().catch(undefined),
  expiresAt: z.number(),
});

function readWorkspaceDraft() {
  try {
    const parsed = workspaceDraftSchema.safeParse(JSON.parse(sessionStorage.getItem(workspaceDraftKey) ?? 'null'));
    if (parsed.success && parsed.data.expiresAt > Date.now()) return parsed.data;
  } catch {}
  return null;
}

/** An http(s) URL from what the visitor typed, adding https:// when the scheme is missing. */
function normalizeWebsite(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password)
      return null;
    return url.href.length <= 200 ? url.href : null;
  } catch {
    return null;
  }
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
  // Answers from the onboarding chat; undefined when the chat is off or not started.
  const [chatProfile, setProfile] = useState<OnboardingProfile | undefined>(draft?.profile);
  const [website, setWebsite] = useState(draft?.website ?? '');
  const [personName, setPersonName] = useState(draft?.personName ?? '');
  // Where the website came from: typed by the visitor, or found on the web from the workspace name.
  const [websiteSource, setWebsiteSource] = useState<'typed' | 'found' | null>(draft?.website ? 'typed' : null);
  const [lookingUp, setLookingUp] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState(draft?.customSlug != null);
  const websiteURL = normalizeWebsite(website);
  const websiteInvalid = website.trim() !== '' && websiteURL === null;
  // The chat's answers plus the step 1 website, which the chat uses as context.
  const profile =
    chatProfile || websiteURL ? { ...(chatProfile ?? emptyOnboardingProfile), website: websiteURL } : undefined;
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
      if (!name && customSlug === null && !chatProfile && !website && !personName) clearWorkspaceDraft();
      else
        sessionStorage.setItem(
          workspaceDraftKey,
          JSON.stringify({
            name,
            customSlug,
            website,
            personName,
            profile: chatProfile,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          }),
        );
    } catch {}
  }, [name, customSlug, chatProfile, website, personName]);
  // As soon as there's a workspace name, look up its website, unless the visitor typed one.
  const trimmedName = name.trim();
  const typedWebsite = websiteSource === 'typed';
  const lookedUp = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (typedWebsite || trimmedName.length < 2) return;
    // Each name is searched once; going back to an earlier name reuses its answer.
    if (lookedUp.current.has(trimmedName)) {
      const found = lookedUp.current.get(trimmedName) ?? null;
      setWebsite(found ?? '');
      setWebsiteSource(found ? 'found' : null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLookingUp(true);
      void guideVisitor(challenge)
        .then(visitor => findWebsite(visitor, trimmedName, controller.signal))
        .then(found => {
          lookedUp.current.set(trimmedName, found);
          if (controller.signal.aborted) return;
          setWebsite(found ?? '');
          setWebsiteSource(found ? 'found' : null);
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setLookingUp(false);
        });
    }, 700);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setLookingUp(false);
    };
  }, [trimmedName, typedWebsite, challenge]);
  const onChallenge = useCallback((token: string | null) => setChallenge(token), []);
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
    if (websiteInvalid || !personName.trim()) return false;
    return onboardingDetailsSchema.safeParse({ name, slug, accountType, messages: [], profile }).success;
  }
  async function prepare() {
    setSubmitted(true);
    const parsed = onboardingDetailsSchema.safeParse({
      name,
      slug,
      accountType,
      messages: onboardingChatMessages(),
      profile,
    });
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
  const slugError =
    (submitted && (customSlug !== null || name.trim()) ? workspaceSlugError(slug) : undefined) ??
    (availabilityError?.slug === slug ? availabilityError.message : undefined);
  const fields = (
    <div className="grid gap-5">
      <Field
        id="onboarding-workspace-name"
        label="Business or workspace name"
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
      {editingSlug || slugError ? (
        <Field
          id="onboarding-workspace-slug"
          label="Workspace URL"
          required
          disabled={disabled}
          helper="You can’t change this later."
          // A URL derived from an empty name is not the visitor's mistake; the name error covers it.
          error={slugError}
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
      ) : (
        slug && (
          <div className="-mt-3 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
            <span className="truncate">
              {window.location.host}/<span className="font-medium text-foreground">{slug}</span>
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label="Edit workspace URL"
              onClick={() => setEditingSlug(true)}
            >
              <EditIcon aria-hidden="true" />
            </Button>
          </div>
        )
      )}
      <Field
        id="onboarding-person-name"
        label="Your name"
        required
        disabled={disabled}
        error={submitted && !personName.trim() ? 'Enter your name.' : undefined}
      >
        <Input
          name="name"
          scale="lg"
          autoComplete="name"
          placeholder="Ada Lovelace"
          maxLength={80}
          value={personName}
          onChange={event => setPersonName(event.target.value)}
        />
      </Field>
      <Field
        id="onboarding-workspace-website"
        label="Website"
        optional
        disabled={disabled}
        helper={
          lookingUp
            ? 'Looking for your website…'
            : websiteSource === 'found'
              ? 'We found this on the web. Change it if it’s not yours.'
              : 'Helps us suggest the right agents.'
        }
        error={submitted && websiteInvalid ? 'Enter a website address, like acme-studio.com.' : undefined}
      >
        <Input
          name="workspace-website"
          type="url"
          inputMode="url"
          scale="lg"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="acme-studio.com"
          maxLength={200}
          value={website}
          onChange={event => {
            setWebsite(event.target.value);
            setWebsiteSource(event.target.value.trim() ? 'typed' : null);
          }}
        />
      </Field>
      <div className="sr-only">
        <AuthVerification action="public_guide" onToken={onChallenge} />
      </div>
    </div>
  );
  return {
    fields,
    prepare,
    validate,
    checkAvailability: () => checkAvailability(slug),
    details: { name: name.trim(), slug },
    profile,
    setProfile,
    personName: personName.trim(),
  };
}
