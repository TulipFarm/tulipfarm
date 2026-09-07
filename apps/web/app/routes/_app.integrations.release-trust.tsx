import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { type FormEvent, useRef, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ShieldOff } from "~/components/icons";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty, PanelRow } from "~/components/ui/panel";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import {
  addOimTrustRoot,
  disableOimRevocationFeed,
  disableOimTrustRoot,
  getOimRevocationFeed,
  importOimRevocations,
  listOimTrustRoots,
  type OimRevocationFeed,
  type OimTrustRoot,
  type OimTrustRootPurpose,
  setOimRevocationFeed,
} from "~/lib/oim-release-trust";
import { usePublishPageTitle } from "~/lib/page-chrome-context";

export const meta: MetaFunction = () => [{ title: "Release trust · tulipfarm" }];

export async function clientLoader(_: ClientLoaderFunctionArgs) {
  const [roots, feed] = await Promise.all([listOimTrustRoots(), getOimRevocationFeed()]);
  return { roots, feed };
}

function message(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 403
      ? "You do not have permission to manage release trust."
      : error.message;
  }
  return error instanceof Error ? error.message : "Request failed.";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function validatePublicKey(value: string): string | undefined {
  if (value.includes("PRIVATE KEY")) {
    return "Paste a public key. Private keys must never leave the signing system.";
  }
  if (
    !value.includes("-----BEGIN PUBLIC KEY-----") ||
    !value.includes("-----END PUBLIC KEY-----")
  ) {
    return "Paste an Ed25519 public key in PEM format.";
  }
  return undefined;
}

function TrustRootsPanel({ initialRoots }: { initialRoots: OimTrustRoot[] }) {
  const [roots, setRoots] = useState(initialRoots);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [purpose, setPurpose] = useState<OimTrustRootPurpose>("release");
  const [keyId, setKeyId] = useState("");
  const [publicKeyPem, setPublicKeyPem] = useState("");
  const [keyError, setKeyError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState<string>();
  const publicKeyRef = useRef<HTMLTextAreaElement>(null);

  async function reload(showDisabled: boolean) {
    setError(undefined);
    try {
      setRoots(await listOimTrustRoots(showDisabled));
    } catch (caught) {
      setError(message(caught));
    }
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const trimmedKey = publicKeyPem.trim();
    const validation = validatePublicKey(trimmedKey);
    setKeyError(validation);
    if (validation) {
      publicKeyRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const root = await addOimTrustRoot({
        purpose,
        keyId: keyId.trim(),
        publicKeyPem: trimmedKey,
      });
      setRoots((current) => [...current, root]);
      setKeyId("");
      setPublicKeyPem("");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onDisable(root: OimTrustRoot) {
    setDisabling(`${root.purpose}:${root.keyId}`);
    setError(undefined);
    try {
      const disabled = await disableOimTrustRoot(root.purpose, root.keyId);
      setRoots((current) =>
        includeDisabled
          ? current.map((item) =>
              item.purpose === disabled.purpose && item.keyId === disabled.keyId ? disabled : item
            )
          : current.filter(
              (item) => item.purpose !== disabled.purpose || item.keyId !== disabled.keyId
            )
      );
    } catch (caught) {
      setError(message(caught));
    } finally {
      setDisabling(undefined);
    }
  }

  return (
    <Panel
      title="Trusted public keys"
      description="Only keys added here can mark a signed package Official or authorize a signed revocation list. Private keys never belong in TulipFarm."
    >
      <div className="space-y-5">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}

        <form onSubmit={onAdd} className="space-y-4 rounded-md bg-muted/40 p-3">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Key purpose</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {(
                [
                  ["release", "Release signing"],
                  ["revocation", "Revocation signing"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-7 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="trust-root-purpose"
                    value={value}
                    checked={purpose === value}
                    onChange={() => setPurpose(value)}
                    className="size-4 accent-foreground"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <Field
            label="Key ID"
            required
            help="Use the exact ID carried by the publisher's signed envelope."
          >
            <Input
              value={keyId}
              required
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              placeholder="releases-2026"
              onChange={(event) => setKeyId(event.target.value)}
            />
          </Field>

          <Field
            label="Public key"
            required
            help="Ed25519 public key in PEM format. A private key is always rejected."
            error={keyError}
          >
            <Textarea
              ref={publicKeyRef}
              value={publicKeyPem}
              required
              autoComplete="off"
              spellCheck={false}
              className="min-h-36 font-mono text-xs"
              placeholder={"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"}
              onChange={(event) => {
                setPublicKeyPem(event.target.value);
                setKeyError(undefined);
              }}
            />
          </Field>

          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add trusted public key"}
          </Button>
        </form>

        <label className="flex min-h-7 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeDisabled}
            onChange={(event) => {
              const checked = event.target.checked;
              setIncludeDisabled(checked);
              void reload(checked);
            }}
            className="size-4 accent-foreground"
          />
          <span>Show disabled keys</span>
        </label>

        <div className="overflow-hidden rounded-md border border-border">
          {roots.length === 0 ? (
            <PanelEmpty>No trusted public keys.</PanelEmpty>
          ) : (
            roots.map((root) => {
              const disableId = `${root.purpose}:${root.keyId}`;
              return (
                <PanelRow
                  key={disableId}
                  className="items-start max-sm:flex-col max-sm:items-stretch"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium">{root.keyId}</span>
                      <Badge>{root.purpose === "release" ? "Release" : "Revocation"}</Badge>
                      {root.disabledAt ? <Badge>Disabled</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Added by {root.createdBy} ·{" "}
                      <time dateTime={root.createdAt}>{formatDate(root.createdAt)}</time>
                    </p>
                    {root.disabledAt ? (
                      <p className="text-xs text-muted-foreground">
                        Disabled by {root.disabledBy ?? "unknown"} ·{" "}
                        <time dateTime={root.disabledAt}>{formatDate(root.disabledAt)}</time>
                      </p>
                    ) : null}
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2.5 py-2 text-xs">
                      {root.publicKeyPem}
                    </pre>
                  </div>
                  {!root.disabledAt ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={disabling === disableId}
                      onClick={() => onDisable(root)}
                      aria-label={`Disable ${root.keyId}`}
                    >
                      <ShieldOff aria-hidden className="size-4" />
                      {disabling === disableId ? "Disabling…" : "Disable"}
                    </Button>
                  ) : null}
                </PanelRow>
              );
            })
          )}
        </div>
      </div>
    </Panel>
  );
}

function RevocationFeedPanel({ initialFeed }: { initialFeed: OimRevocationFeed | null }) {
  const [feed, setFeed] = useState(initialFeed);
  const [url, setUrl] = useState(initialFeed?.url ?? "");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const next = await setOimRevocationFeed(url.trim());
      setFeed(next);
      setUrl(next.url);
      setDone("Signed release feed saved.");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      await disableOimRevocationFeed();
      setFeed(null);
      setDone("Automatic feed checks disabled.");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Signed release feed"
      description="TulipFarm reads this credential-free HTTPS feed for signed revocations and trusted patch releases."
    >
      <form onSubmit={onSave} className="space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}
        {done ? <FormStatus tone="success">{done}</FormStatus> : null}
        <Field
          label="Feed URL"
          required
          help="The feed must use HTTPS and must not contain a username, password, or fragment."
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            value={url}
            placeholder="https://updates.example.com/oim/releases.json"
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        {feed ? (
          <p className="text-xs text-muted-foreground">
            Last configured by {feed.updatedBy} ·{" "}
            <time dateTime={feed.updatedAt}>{formatDate(feed.updatedAt)}</time>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save feed"}
          </Button>
          {feed ? (
            <Button type="button" variant="outline" disabled={busy} onClick={onDisable}>
              Disable automatic checks
            </Button>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}

function RevocationImportPanel() {
  const [document, setDocument] = useState("");
  const [error, setError] = useState<string>();
  const [documentError, setDocumentError] = useState<string>();
  const [accepted, setAccepted] = useState<{ sequence: number; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const documentRef = useRef<HTMLTextAreaElement>(null);

  async function onImport(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setDocumentError(undefined);
    setAccepted(undefined);
    let envelope: unknown;
    try {
      envelope = JSON.parse(document);
    } catch {
      setDocumentError("Paste a valid signed revocation JSON document.");
      documentRef.current?.focus();
      return;
    }
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      setDocumentError("The signed revocation document must be a JSON object.");
      documentRef.current?.focus();
      return;
    }

    setBusy(true);
    try {
      const result = await importOimRevocations(envelope);
      setAccepted(result);
      setDocument("");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Import signed revocations"
      description="Import a complete publisher-signed list. TulipFarm verifies it with an active revocation key and rejects stale or rolled-back lists."
    >
      <form onSubmit={onImport} className="space-y-4">
        {error ? <FormStatus tone="error">{error}</FormStatus> : null}
        {accepted ? (
          <FormStatus tone="success">
            Accepted sequence {accepted.sequence}. It expires{" "}
            <time dateTime={accepted.expiresAt}>{formatDate(accepted.expiresAt)}</time>.
          </FormStatus>
        ) : null}
        <Field
          label="Signed revocation JSON"
          required
          help="The document must contain its list and Ed25519 signature. It cannot add a trust key."
          error={documentError}
        >
          <Textarea
            ref={documentRef}
            value={document}
            required
            autoComplete="off"
            spellCheck={false}
            className="min-h-48 font-mono text-xs"
            placeholder='{"envelopeVersion":1,"list":{…},"signature":{…}}'
            onChange={(event) => {
              setDocument(event.target.value);
              setDocumentError(undefined);
            }}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Verifying…" : "Verify and import"}
        </Button>
      </form>
    </Panel>
  );
}

export default function OimReleaseTrustPage() {
  const { roots, feed } = useLoaderData<typeof clientLoader>();
  usePublishPageTitle("Release trust");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <TrustRootsPanel initialRoots={roots} />
      <RevocationFeedPanel initialFeed={feed} />
      <RevocationImportPanel />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  return (
    <ErrorState
      section="release trust"
      {...(status === undefined ? {} : { status })}
      {...(error instanceof Error ? { message: message(error) } : {})}
    />
  );
}
