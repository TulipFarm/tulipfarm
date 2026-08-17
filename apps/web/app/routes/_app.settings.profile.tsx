import { useRevalidator } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { MemoryDocumentPanel } from "~/components/settings/memory-document-panel";
import { Button } from "~/components/ui/button";
import { Field, ReadonlyField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { ApiError, updateProfile } from "~/lib/api";
import { useSessionUser } from "~/lib/use-session-user";

const MAX_NAME_CHARS = 80;

/** Email and Role are administered elsewhere, so this page shows why they are fixed. */
export default function ProfileSettings() {
  const user = useSessionUser();
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
        title="Display name"
        description="Used wherever you are shown to other people. Leave it empty to be shown by email."
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
        <form id="profile-form" onSubmit={onSubmit} className="space-y-4">
          {error ? <FormStatus tone="error">{error}</FormStatus> : null}
          {saved && !dirty ? <FormStatus tone="success">Display name updated.</FormStatus> : null}

          <Field
            label="Name"
            help="Your real name or whatever you go by."
            error={tooLong ? `Names are limited to ${MAX_NAME_CHARS} characters.` : undefined}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="e.g. Priya Raghunathan"
            />
          </Field>
        </form>
      </Panel>

      <Panel
        title="Account"
        description="Administered for you. Ask an admin if either needs to change."
      >
        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadonlyField label="Email">{user?.email ?? "—"}</ReadonlyField>
          <ReadonlyField label="Role">{user?.role ?? "—"}</ReadonlyField>
          <ReadonlyField label="Status">{user?.status ?? "—"}</ReadonlyField>
          <ReadonlyField label="User ID">
            <span className="font-mono text-xs">{user?.id ?? "—"}</span>
          </ReadonlyField>
        </dl>
      </Panel>

      <MemoryDocumentPanel />
    </div>
  );
}
