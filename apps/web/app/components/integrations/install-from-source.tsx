import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { inspectIntegrationSource, installIntegration } from "~/lib/integrations";

/*
 * Install an integration from any git repository.
 *
 * Two steps on purpose. Inspecting first is what makes the curated catalog curation rather than an
 * allowlist: a repo nobody vetted can still be installed, but the operator is shown what it
 * declares — and why the host refuses it, when it declares something executable — before anything
 * is written to the soul repo.
 */

type Offer = { name: string; description?: string; installable: boolean; issues: string[] };

export function InstallFromSource({ onInstalled }: { onInstalled: () => void }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [offers, setOffers] = useState<Offer[]>();
  const [busy, setBusy] = useState<string | true>();
  const [error, setError] = useState<string>();
  const sourceId = useId();

  function close() {
    setOpen(false);
    setSource("");
    setOffers(undefined);
    setError(undefined);
    setBusy(undefined);
  }

  async function inspect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setOffers(undefined);
    try {
      const result = await inspectIntegrationSource(source.trim());
      setOffers(result.integrations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that repository.");
    } finally {
      setBusy(undefined);
    }
  }

  async function install(name: string) {
    setBusy(name);
    setError(undefined);
    try {
      await installIntegration(source.trim(), name);
      onInstalled();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed.");
      setBusy(undefined);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Install from git
      </Button>
      <Modal open={open} onClose={close} title="Install from a git repository">
        <form className="flex flex-col gap-3" onSubmit={inspect}>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor={sourceId}>
              Repository
            </label>
            <Input
              id={sourceId}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="owner/repo or https://host/owner/repo#branch"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The repository is cloned and read. Nothing is written until you choose an integration
              below.
            </p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={busy === true || source.trim().length === 0}>
              {busy === true ? "Reading…" : "Read repository"}
            </Button>
          </div>
        </form>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        {offers?.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            That repository offers no integrations.
          </p>
        )}

        {offers && offers.length > 0 && (
          <ul className="mt-4 flex flex-col divide-y divide-border rounded-sm border border-border">
            {offers.map((offer) => (
              <li key={offer.name} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {offer.name}
                  </span>
                  <Button
                    size="sm"
                    disabled={!offer.installable || busy !== undefined}
                    onClick={() => install(offer.name)}
                  >
                    {busy === offer.name ? "Installing…" : "Install"}
                  </Button>
                </div>
                {offer.description && (
                  <p className="text-xs text-muted-foreground">{offer.description}</p>
                )}
                {/* Naming the refused construct is the point: "not installable" alone reads as a
                    bug in the catalog rather than a deliberate limit on what a stranger's repo
                    may declare. */}
                {offer.issues.map((issue) => (
                  <p key={issue} className="text-xs text-destructive">
                    {issue}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
