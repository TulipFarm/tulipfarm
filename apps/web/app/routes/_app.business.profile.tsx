import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { CURRENCIES } from "@tulipfarm/schema/currencies";
import { useEffect, useId, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Field, ReadonlyField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import { type BusinessProfile, getBusinessProfile, putBusinessProfile } from "~/lib/settings";
import { useIsAdmin } from "~/lib/use-session-user";

/** "USD — US Dollar", falling back to the bare code for one the list somehow doesn't carry. */
function currencyLabel(code: string): string {
  const entry = CURRENCIES.find((c) => c.code === code);
  return entry ? `${entry.code} — ${entry.name}` : code;
}

const CURRENCY_OPTIONS = CURRENCIES.map((c) => currencyLabel(c.code));

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
  // The Combobox's `value` is the literal input text; it must be its own state so a keystroke
  // isn't reverted next render, and re-synced whenever the committed currency changes elsewhere
  // (a fresh load, or Cancel resetting the whole draft).
  const [currencyQuery, setCurrencyQuery] = useState(() => currencyLabel(draft.businessCurrency));
  useEffect(() => {
    setCurrencyQuery(currencyLabel(draft.businessCurrency));
  }, [draft.businessCurrency]);
  const currencyFieldId = useId();

  const dirty =
    draft.name !== profile.name ||
    draft.description !== profile.description ||
    draft.website !== profile.website ||
    draft.businessCurrency !== profile.businessCurrency ||
    draft.businessCurrencyRate !== profile.businessCurrencyRate;

  const nameMissing = draft.name.trim().length === 0;

  function set<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDone(false);
  }

  function setCurrency(code: string) {
    setDraft((prev) => ({
      ...prev,
      businessCurrency: code,
      businessCurrencyRate: code === "USD" ? 1 : prev.businessCurrencyRate,
    }));
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
        businessCurrency: draft.businessCurrency,
        businessCurrencyRate: draft.businessCurrency === "USD" ? 1 : draft.businessCurrencyRate,
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
          <ReadonlyField label="Currency">
            {profile.businessCurrency === "USD"
              ? "USD"
              : `${profile.businessCurrency} (1 USD = ${profile.businessCurrencyRate} ${profile.businessCurrency})`}
          </ReadonlyField>
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
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || nameMissing}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}
        {done && !dirty ? <FormStatus tone="success">Business profile updated.</FormStatus> : null}

        <Field
          label="Name"
          help="What your business is called."
          error={nameMissing ? "Name can't be empty." : undefined}
          required
        >
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

        <Field
          label="Currency"
          htmlFor={currencyFieldId}
          help="Cost figures on the Cost page display in this currency."
        >
          <div className="flex items-center gap-2">
            <Combobox
              id={currencyFieldId}
              value={currencyQuery}
              options={CURRENCY_OPTIONS}
              onValueChange={setCurrencyQuery}
              onCommit={(next) => {
                const match = CURRENCIES.find((c) => currencyLabel(c.code) === next);
                if (match) setCurrency(match.code);
                else setCurrencyQuery(currencyLabel(draft.businessCurrency));
              }}
              placeholder="Search currency…"
              emptyLabel="No matching currency."
              className="w-64"
            />
            <span className="shrink-0 text-xs text-muted-foreground">1 USD =</span>
            <Input
              type="number"
              min={0}
              step="any"
              value={draft.businessCurrency === "USD" ? 1 : draft.businessCurrencyRate}
              disabled={draft.businessCurrency === "USD"}
              onChange={(e) => set("businessCurrencyRate", Number(e.target.value))}
              className="w-28"
            />
          </div>
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
