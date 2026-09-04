import { useRevalidator } from "@remix-run/react";
import { type FormEvent, useId, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { MemoryDocumentPanel } from "~/components/settings/memory-document-panel";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Panel, SettingRow } from "~/components/ui/panel";
import { ApiError, updateProfile } from "~/lib/api";
import { useSessionUser } from "~/lib/use-session-user";

const MAX_NAME_CHARS = 80;

/** Email and Role are administered elsewhere, so this page shows why they are fixed. */
export default function ProfileSettings() {
  const user = useSessionUser();
  const nameId = useId();
  const revalidator = useRevalidator();
  const [name, setName] = useState(user?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = name.trim();
  const dirty = trimmed !== (user?.name ?? "");
  const tooLong = trimmed.length > MAX_NAME_CHARS;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await updateProfile(trimmed.length > 0 ? trimmed : null);
      setSaved(true);
      // The sidebar's account chip reads the same loader, so it renames itself with the page.
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Profile"
        description="Your display name is yours to change. Email, role and status are administered for you — ask an admin if either needs to change."
        flush
        footer={
          <>
            <span className="text-xs text-muted-foreground">
              {trimmed.length > 0 ? `${trimmed.length}/${MAX_NAME_CHARS}` : "Not set"}
            </span>
            <Button
              type="submit"
              form="profile-form"
              size="sm"
              disabled={busy || !dirty || tooLong}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form id="profile-form" onSubmit={onSubmit} className="px-4">
          {error || (saved && !dirty) ? (
            <div className="pt-4">
              {error ? <FormStatus tone="error">{error}</FormStatus> : null}
              {saved && !dirty ? (
                <FormStatus tone="success">Display name updated.</FormStatus>
              ) : null}
            </div>
          ) : null}

          <SettingRow
            label="Name"
            description="Used wherever you are shown to other people. Leave it empty to be shown by email."
            htmlFor={nameId}
          >
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="e.g. Muskan Vijayvargiya"
              aria-invalid={tooLong || undefined}
              aria-describedby={tooLong ? `${nameId}-error` : undefined}
            />
            {tooLong ? (
              <p id={`${nameId}-error`} className="mt-1.5 text-xs text-destructive">
                Names are limited to {MAX_NAME_CHARS} characters.
              </p>
            ) : null}
          </SettingRow>

          <SettingRow label="Email" description="The address you sign in with.">
            <p className="text-sm text-foreground">{user?.email ?? "-"}</p>
          </SettingRow>

          <SettingRow label="Role" description="What the business has granted you.">
            <p className="text-sm text-foreground">{user?.role ?? "-"}</p>
          </SettingRow>

          <SettingRow label="Status" description="Whether this account may sign in.">
            <p className="text-sm text-foreground">{user?.status ?? "-"}</p>
          </SettingRow>

          <SettingRow label="User ID" description="Quote it when reporting a problem.">
            <p className="font-mono text-xs break-all text-foreground">{user?.id ?? "-"}</p>
          </SettingRow>
        </form>
      </Panel>

      <MemoryDocumentPanel />
    </div>
  );
}
