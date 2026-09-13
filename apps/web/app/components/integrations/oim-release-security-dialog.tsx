import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import {
  addOimTrustRoot,
  disableOimRevocationFeed,
  disableOimTrustRoot,
  getOimRevocationFeed,
  listOimTrustRoots,
  type OimRevocationFeed,
  type OimTrustRoot,
  runOimReleaseMaintenance,
  setOimRevocationFeed,
} from "~/lib/integrations";

type Confirmation =
  | { kind: "root"; root: OimTrustRoot }
  | { kind: "feed"; feed: OimRevocationFeed };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export function OimReleaseSecurityDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [roots, setRoots] = useState<readonly OimTrustRoot[]>([]);
  const [feed, setFeed] = useState<OimRevocationFeed | null>(null);
  const [purpose, setPurpose] = useState<OimTrustRoot["purpose"]>("release");
  const [keyId, setKeyId] = useState("");
  const [publicKeyPem, setPublicKeyPem] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const generation = useRef(0);
  const keyIdInput = useRef<HTMLInputElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus();
  }, [confirmation]);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy("load");
    setError("");
    try {
      const [nextRoots, nextFeed] = await Promise.all([
        listOimTrustRoots(true),
        getOimRevocationFeed(),
      ]);
      if (request !== generation.current) return;
      setRoots(nextRoots);
      setFeed(nextFeed);
      setFeedUrl(nextFeed?.url ?? "");
      setStatus("Package security settings loaded.");
    } catch (cause) {
      if (request !== generation.current) return;
      setError(message(cause));
      setStatus("Package security settings could not be loaded.");
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else generation.current += 1;
  }, [open, load]);

  async function addRoot() {
    if (!keyId.trim() || !publicKeyPem.trim()) {
      setError("Enter a key ID and PEM public key.");
      keyIdInput.current?.focus();
      return;
    }
    setBusy("root");
    setError("");
    try {
      await addOimTrustRoot({
        purpose,
        keyId: keyId.trim(),
        publicKeyPem: publicKeyPem.trim(),
      });
      setKeyId("");
      setPublicKeyPem("");
      await load();
      setStatus("Public trust root added.");
    } catch (cause) {
      setError(message(cause));
      setBusy("");
    }
  }

  async function confirmDisable() {
    if (!confirmation) return;
    setBusy("disable");
    setError("");
    try {
      if (confirmation.kind === "root") {
        await disableOimTrustRoot(confirmation.root.purpose, confirmation.root.keyId);
      } else {
        await disableOimRevocationFeed();
      }
      const disabledStatus =
        confirmation.kind === "root"
          ? "Public trust root disabled."
          : "Signed revocation feed disabled.";
      setConfirmation(undefined);
      await load();
      setStatus(disabledStatus);
    } catch (cause) {
      setError(message(cause));
      setBusy("");
    }
  }

  async function saveFeed() {
    if (!feedUrl.trim()) {
      setError("Enter an HTTPS signed revocation feed URL.");
      return;
    }
    setBusy("feed");
    setError("");
    try {
      const saved = await setOimRevocationFeed(feedUrl.trim());
      setFeed(saved);
      setFeedUrl(saved.url);
      setStatus("Signed revocation feed saved.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  }

  async function runMaintenance() {
    setBusy("maintenance");
    setError("");
    try {
      const result = await runOimReleaseMaintenance();
      const updated = result.patches.filter((patch) => patch.status === "updated").length;
      const failed = result.patches.filter((patch) => patch.status === "failed").length;
      setStatus(
        result.feed === "disabled"
          ? "Maintenance finished. No signed revocation feed is configured."
          : `Maintenance finished. Revocations ${result.feed}; ${updated} package updates applied; ${failed} failed.`
      );
    } catch (cause) {
      setError(message(cause));
      setStatus("Maintenance failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="OIM package security" className="max-w-2xl">
      <div className="space-y-6">
        <p className="text-muted-foreground">
          Trust roots contain public verification keys only. Keep signing private keys with the
          package publisher. Provider credentials are managed separately when you connect.
        </p>

        <section aria-labelledby="trust-roots-heading" className="space-y-3">
          <h3 id="trust-roots-heading" className="font-medium">
            Public trust roots
          </h3>
          {roots.length === 0 ? (
            <p className="text-muted-foreground">No public trust roots configured.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border">
              {roots.map((root) => (
                <li key={`${root.purpose}:${root.keyId}`} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{root.keyId}</p>
                    <p className="text-xs text-muted-foreground">
                      {root.purpose === "release" ? "Release signing" : "Revocation signing"}
                      {root.disabledAt ? " · disabled" : " · active"}
                    </p>
                  </div>
                  {!root.disabledAt ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmation({ kind: "root", root })}
                    >
                      Disable
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <fieldset className="space-y-2">
            <legend className="font-medium">Add a public trust root</legend>
            <div className="flex gap-4">
              {(["release", "revocation"] as const).map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="trust-root-purpose"
                    checked={purpose === value}
                    onChange={() => setPurpose(value)}
                  />
                  {value === "release" ? "Release signatures" : "Revocation signatures"}
                </label>
              ))}
            </div>
            <label htmlFor="oim-trust-key-id" className="block font-medium">
              Key ID
            </label>
            <input
              ref={keyIdInput}
              id="oim-trust-key-id"
              value={keyId}
              onChange={(event) => setKeyId(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2"
            />
            <label htmlFor="oim-trust-public-key" className="block font-medium">
              PEM public key
            </label>
            <textarea
              id="oim-trust-public-key"
              value={publicKeyPem}
              onChange={(event) => setPublicKeyPem(event.target.value)}
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono"
            />
            <Button type="button" disabled={Boolean(busy)} onClick={() => void addRoot()}>
              Add public trust root
            </Button>
          </fieldset>
        </section>

        <section aria-labelledby="revocation-feed-heading" className="space-y-2">
          <h3 id="revocation-feed-heading" className="font-medium">
            Signed revocation feed
          </h3>
          <p className="text-muted-foreground">
            TulipFarm fetches this credential-free HTTPS feed only when maintenance runs.
          </p>
          <label htmlFor="oim-revocation-feed" className="sr-only">
            Signed revocation feed URL
          </label>
          <input
            id="oim-revocation-feed"
            type="url"
            value={feedUrl}
            onChange={(event) => setFeedUrl(event.target.value)}
            placeholder="https://updates.example.com/oim-feed.json"
            className="w-full rounded-md border border-input bg-background px-3 py-2"
          />
          <div className="flex gap-2">
            <Button type="button" disabled={Boolean(busy)} onClick={() => void saveFeed()}>
              Save feed
            </Button>
            {feed && !feed.disabledAt ? (
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => setConfirmation({ kind: "feed", feed })}
              >
                Disable feed
              </Button>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="maintenance-heading" className="space-y-2">
          <h3 id="maintenance-heading" className="font-medium">
            Maintenance
          </h3>
          <p className="text-muted-foreground">
            Check the signed feed now and apply eligible patches to opted-in Official packages.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void runMaintenance()}
          >
            {busy === "maintenance" ? "Running maintenance…" : "Run maintenance"}
          </Button>
        </section>

        {confirmation ? (
          <section
            aria-labelledby="oim-disable-confirmation"
            className="rounded-md border border-destructive/40 p-3"
          >
            <h3
              ref={confirmationHeading}
              id="oim-disable-confirmation"
              tabIndex={-1}
              className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Confirm disable
            </h3>
            <p className="text-muted-foreground">
              {confirmation.kind === "root"
                ? `Disable ${confirmation.root.keyId}? New packages using this public key will not verify.`
                : "Disable the signed revocation feed? Automatic revocation and patch checks will stop."}
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={Boolean(busy)}
                onClick={() => void confirmDisable()}
              >
                Confirm disable
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmation(undefined)}>
                Cancel
              </Button>
            </div>
          </section>
        ) : null}

        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <p role="status" className="text-muted-foreground">
          {busy === "load" ? "Loading package security settings…" : status}
        </p>
      </div>
    </Modal>
  );
}
