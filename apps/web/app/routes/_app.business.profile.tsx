import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Field, ReadonlyField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import { type BusinessProfile, getBusinessProfile, putBusinessProfile } from "~/lib/settings";
import { useIsAdmin } from "~/lib/use-session-user";

/** A raw "forbidden" from the API is not a sentence anyone can act on. */
function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    return err.status === 403
      ? "Only an admin can change the business profile."
      : err.message || "The change was rejected.";
  }
  return "Could not reach the API.";
}

export async function clientLoader() {
  return { profile: await getBusinessProfile() };
}

/**
 * The identity block in `soul.yaml`. Every agent reads these values as context, so they were the
 * one thing the product asked for during setup and then never let anyone correct.
 */
export default function BusinessProfilePage() {
  const { profile } = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  const revalidator = useRevalidator();

  const [draft, setDraft] = useState<BusinessProfile>(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dirty =
    draft.name !== profile.name ||
    draft.description !== profile.description ||
    draft.website !== profile.website;

  function set<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDone(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await putBusinessProfile({
        name: draft.name.trim(),
        description: draft.description.trim(),
        website: draft.website.trim(),
      });
      setDone(true);
      revalidator.revalidate();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <Panel
        title="Business profile"
        description="Only an admin can change these. Ask one if something here is wrong."
      >
        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadonlyField label="Name">{profile.name || "-"}</ReadonlyField>
          <ReadonlyField label="Website">{profile.website || "-"}</ReadonlyField>
          <ReadonlyField label="What it does" className="sm:col-span-2">
            {profile.description || "-"}
          </ReadonlyField>
        </dl>
      </Panel>
    );
  }

  return (
    <Panel
      title="Business profile"
      description="Committed to the soul repository, so every change is versioned alongside the rest of your configuration."
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            Agents see these values on every turn.
          </span>
          <div className="flex items-center gap-2">
            {dirty ? (
              <Button variant="ghost" size="sm" onClick={() => setDraft(profile)} disabled={busy}>
                Cancel
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}
        {done && !dirty ? <FormStatus tone="success">Business profile updated.</FormStatus> : null}

        <Field label="Name" help="What your business is called.">
          <Input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Ridgeline Landscaping"
          />
        </Field>

        <Field
          label="What it does"
          help="A sentence or two. Agents use this to judge what is and is not relevant to you."
        >
          <Textarea
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            rows={4}
            placeholder="e.g. Two-person landscaping crew in Portland. Residential maintenance contracts, invoiced monthly."
          />
        </Field>

        <Field label="Website" help="Optional.">
          <Input
            type="url"
            value={draft.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://example.com"
          />
        </Field>
      </div>
    </Panel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="business" status={status} message={message} />;
}
