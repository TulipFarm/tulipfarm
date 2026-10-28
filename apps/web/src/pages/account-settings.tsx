import { useEffect, useState, type FormEvent } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { Monitor } from 'reicon-react/icons/Monitor';
import { Moon } from 'reicon-react/icons/Moon';
import { Sun } from 'reicon-react/icons/Sun';
import { workspaceRoute } from '@/router';
import { authClient } from '@/lib/auth';
import { analytics } from '@/lib/analytics';
import { preferencesEvent } from '@/lib/browser-analytics';
import { readTheme, saveTheme, themes, type Theme } from '@/lib/theme';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { AvatarImagePicker } from '@/features/avatar/image-picker';
import { UnsavedChanges } from '@/features/tables/feedback';
import { PersonalMemoryEditor } from '@/features/settings/personal-memory';
import { useFeatureRead } from '@/lib/query';
import { accountSignInMethods } from '@/lib/account-details';
import { newPasswordError, passwordFailureMessage, passwordLength } from '@/features/auth/form';
import { PublicAuthQueryProvider, useAuthOptions } from '@/features/auth/public-query';

type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

export function AccountSettingsPage() {
  const { user, workspace } = workspaceRoute.useRouteContext();
  return (
    <PageContent>
      <PageHeader
        titleId="account-heading"
        focusable
        title="Account"
        description="Manage your profile, appearance, and this workspace's personal memory."
      />
      <SettingsGroup title="Profile" titleId="profile-heading">
        <ProfilePicture key={`picture:${user.id}`} />
        <ProfileName key={`name:${user.id}`} />
        <SettingsRow label="Email" description="Used to sign in.">
          <span className="break-all text-sm">{user.email}</span>
        </SettingsRow>
        <SignInMethods />
        <PublicAuthQueryProvider>
          <PasswordSettings key={`password:${user.id}`} />
        </PublicAuthQueryProvider>
      </SettingsGroup>
      <SettingsGroup title="Preferences" titleId="preferences-heading">
        <ThemePreference />
        {analytics.configured() && (
          <SettingsRow label="Analytics" description="Review or change optional analytics for this browser.">
            <Button variant="outline" onClick={() => window.dispatchEvent(new Event(preferencesEvent))}>
              Analytics preferences
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>
      <div className="pb-20">
        <PersonalMemoryEditor
          key={`memory:${workspace.id}:${user.id}`}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
        />
      </div>
    </PageContent>
  );
}

function SignInMethods() {
  const read = useFeatureRead({ key: ['account', 'sign-in-methods'], load: accountSignInMethods });
  const error =
    read.state.kind === 'error' ||
    read.state.kind === 'unavailable' ||
    (read.state.kind === 'ready' && !!read.state.error);
  return (
    <SettingsRow
      label="Sign-in methods"
      description="Private to your account. Available ways to sign in, not a record of past logins."
    >
      <div className="space-y-2">
        {read.state.kind === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading sign-in methods…
          </p>
        )}
        {read.state.kind === 'ready' && (
          <p className="text-sm">
            {read.state.data.methods.map(method => (method === 'google' ? 'Google' : 'Email link')).join(' · ')}
          </p>
        )}
        {error && (
          <>
            <p role="alert" className="text-sm text-destructive">
              Could not check your sign-in methods.
            </p>
            <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
              Retry sign-in methods
            </Button>
          </>
        )}
      </div>
    </SettingsRow>
  );
}

type PasswordAccount = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; hasPassword: boolean };

// Shown only when the instance allows email and password sign-in (password in AUTH_METHODS).
function PasswordSettings() {
  const options = useAuthOptions();
  if (!options.data?.emailPassword) return null;
  return <PasswordRow resetByEmail={options.data.passwordResetEmail} />;
}

function PasswordRow({ resetByEmail }: { resetByEmail: boolean }) {
  const [account, setAccount] = useState<PasswordAccount>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  async function load() {
    setAccount({ kind: 'loading' });
    const result = await authClient
      .listAccounts({ fetchOptions: { signal: AbortSignal.timeout(15_000) } })
      .catch(() => null);
    setAccount(
      !result || result.error
        ? { kind: 'error' }
        : { kind: 'ready', hasPassword: result.data.some(item => item.providerId === 'credential') },
    );
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <div>
      <SettingsRow
        label="Password"
        description={
          account.kind === 'ready' && !account.hasPassword
            ? resetByEmail
              ? 'No password yet. Email yourself a reset link to set one.'
              : 'No password yet. Ask your administrator for a reset link to set one.'
            : 'Changing it signs you out on your other devices.'
        }
      >
        {account.kind === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking your password…
          </p>
        )}
        {account.kind === 'error' && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              Could not check your password.
            </p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry password
            </Button>
          </div>
        )}
        {account.kind === 'ready' && account.hasPassword && !editing && (
          <Button
            variant="outline"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            Change password
          </Button>
        )}
        {account.kind === 'ready' && !account.hasPassword && resetByEmail && (
          <Button variant="outline" nativeButton={false} render={<Link to="/login/forgot-password" />}>
            Set a password
          </Button>
        )}
      </SettingsRow>
      {editing && (
        <ChangePasswordForm
          onClose={done => {
            setEditing(false);
            setSaved(done);
          }}
        />
      )}
      {saved && (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Password changed. Your other devices were signed out.
        </p>
      )}
    </div>
  );
}

function ChangePasswordForm({ onClose }: { onClose: (done: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const currentError = submitted && !current ? 'Enter your current password.' : undefined;
  const nextError = submitted ? newPasswordError(next) : undefined;
  const confirmationError = submitted && confirmation !== next ? 'The passwords do not match.' : undefined;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (saving || !current || newPasswordError(next) || confirmation !== next) return;
    setSaving(true);
    setError('');
    const result = await authClient
      .changePassword(
        { currentPassword: current, newPassword: next, revokeOtherSessions: true },
        { signal: AbortSignal.timeout(15_000) },
      )
      .catch(() => null);
    setSaving(false);
    if (!result) setError('Could not reach TulipFarm. Your password is unchanged. Try again.');
    else if (result.error)
      setError(
        result.error.code === 'INVALID_PASSWORD'
          ? 'The current password is incorrect.'
          : passwordFailureMessage(result.error, 'Could not change your password. Try again.'),
      );
    else onClose(true);
  }
  return (
    <form noValidate onSubmit={event => void submit(event)} className="space-y-4 px-4 pb-3">
      <Field id="current-password" label="Current password" required error={currentError}>
        <Input
          type="password"
          autoComplete="current-password"
          maxLength={passwordLength.max}
          readOnly={saving}
          value={current}
          onChange={event => setCurrent(event.target.value)}
        />
      </Field>
      <Field
        id="new-password"
        label="New password"
        required
        error={nextError}
        helper={`${passwordLength.min} to ${passwordLength.max} characters.`}
      >
        <Input
          type="password"
          autoComplete="new-password"
          maxLength={passwordLength.max}
          readOnly={saving}
          value={next}
          onChange={event => setNext(event.target.value)}
        />
      </Field>
      <Field id="confirm-password" label="Confirm new password" required error={confirmationError}>
        <Input
          type="password"
          autoComplete="new-password"
          maxLength={passwordLength.max}
          readOnly={saving}
          value={confirmation}
          onChange={event => setConfirmation(event.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" type="button" disabled={saving} onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving ? 'Saving password…' : 'Save password'}
        </Button>
      </div>
    </form>
  );
}

function ProfilePicture() {
  const { user } = workspaceRoute.useRouteContext();
  const router = useRouter();
  const [state, setState] = useState<Save>({ kind: 'idle' });
  const [image, setImage] = useState(user.image ?? null);
  async function save(next: string | null) {
    setState({ kind: 'saving' });
    const result = await authClient
      .updateUser({ image: next }, { signal: AbortSignal.timeout(15_000) })
      .catch(() => null);
    if (!result || result.error) {
      setState({
        kind: 'error',
        message: 'We could not save your picture. Your old picture is still in place. Try again.',
      });
      return;
    }
    setImage(next);
    setState({ kind: 'saved' });
    void router.invalidate();
  }
  return (
    <>
      <SettingsRow
        label="Picture"
        description="Shown beside your name in every workspace. PNG, JPEG, or WebP, up to 2 MB. It is resized to 128 px. Without one, a colored initial is shown."
      >
        <AvatarImagePicker
          seed={user.id}
          name={user.name || user.email}
          image={image}
          shape="circle"
          disabled={state.kind === 'saving'}
          onChange={next => void save(next)}
        />
      </SettingsRow>
      <SaveStatus state={state} saving="Saving picture…" saved="Profile picture saved." />
    </>
  );
}

function ProfileName() {
  const { user } = workspaceRoute.useRouteContext();
  const router = useRouter();
  const [saved, setSaved] = useState(user.name);
  const [name, setName] = useState(user.name);
  const [state, setState] = useState<Save>({ kind: 'idle' });
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 80;
  const dirty = trimmed !== saved;
  const saving = state.kind === 'saving';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || !dirty || saving) return;
    setState({ kind: 'saving' });
    const result = await authClient
      .updateUser({ name: trimmed }, { signal: AbortSignal.timeout(15_000) })
      .catch(() => null);
    if (!result || result.error) {
      setState({ kind: 'error', message: 'We could not save your name. Your draft is kept. Try again.' });
      return;
    }
    setSaved(trimmed);
    setName(trimmed);
    setState({ kind: 'saved' });
    void router.invalidate();
  }
  return (
    <form onSubmit={event => void submit(event)}>
      <UnsavedChanges dirty={dirty && !saving} />
      <SettingsRow
        label="Name"
        htmlFor="account-name"
        description={
          <span id="account-name-help">
            {valid ? 'Shown to people in your workspaces. Up to 80 characters.' : 'Enter a name of 1 to 80 characters.'}
          </span>
        }
      >
        <div className="w-full sm:w-64">
          <Input
            id="account-name"
            value={name}
            maxLength={80}
            required
            autoComplete="name"
            readOnly={saving}
            aria-invalid={!valid}
            aria-describedby="account-name-help"
            onChange={event => {
              setName(event.target.value);
              if (state.kind !== 'saving') setState({ kind: 'idle' });
            }}
          />
        </div>
      </SettingsRow>
      {dirty && (
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3">
          <p className="mr-auto break-words text-sm text-muted-foreground">Current saved name: {saved}</p>
          <Button type="submit" disabled={!valid || saving} aria-busy={saving}>
            {saving ? 'Saving name…' : 'Save name'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={saving}
            onClick={() => {
              setName(saved);
              setState({ kind: 'idle' });
            }}
          >
            Reset name
          </Button>
        </div>
      )}
      <SaveStatus state={state} saved="Name saved." />
    </form>
  );
}

function SaveStatus({ state, saving, saved }: { state: Save; saving?: string; saved: string }) {
  if (state.kind === 'saving' && saving)
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        {saving}
      </p>
    );
  if (state.kind === 'saved')
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        {saved}
      </p>
    );
  if (state.kind === 'error')
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive">
        {state.message}
      </p>
    );
  return null;
}

const themeOptions: Record<Theme, { label: string; icon: typeof Sun }> = {
  system: { label: 'System', icon: Monitor },
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
};

function ThemePreference() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <SettingsRow label="Theme" description="System follows your device. Saved in this browser.">
      <ToggleGroup
        aria-label="Theme"
        variant="outline"
        size="sm"
        spacing={0}
        value={[theme]}
        onValueChange={value => {
          const next = themes.find(item => item === value[0]);
          if (!next) return;
          saveTheme(next);
          setTheme(next);
        }}
      >
        {themes.map(value => {
          const { label, icon: Icon } = themeOptions[value];
          return (
            <ToggleGroupItem key={value} value={value}>
              <Icon size={14} aria-hidden="true" />
              {label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </SettingsRow>
  );
}
