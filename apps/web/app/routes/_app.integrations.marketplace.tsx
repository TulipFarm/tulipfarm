import { type MetaFunction, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { IntegrationsTabs } from "~/components/integrations-tabs";
import { ResourcePanel } from "~/components/resource-panel";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  installIntegrations,
  type MarketplaceCatalog,
  marketplaceIntegrations,
  type ScanResult,
  scanIntegrations,
} from "~/lib/integrations";

export const meta: MetaFunction = () => [{ title: "Marketplace · tulipfarm" }];

export async function clientLoader() {
  return { catalog: await marketplaceIntegrations().catch(() => null) };
}

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "request failed";
}

function InstallBadge({
  installed,
  updateAvailable,
}: {
  installed: boolean;
  updateAvailable: boolean;
}) {
  if (updateAvailable) {
    return (
      <span className="shrink-0 rounded-sm border border-primary px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-primary">
        update available
      </span>
    );
  }
  if (installed) {
    return (
      <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
        installed ✓
      </span>
    );
  }
  return null;
}

function IntegrationList({
  items,
  onSelect,
  selected,
}: {
  items: Array<{
    name: string;
    description?: string;
    installed: boolean;
    updateAvailable: boolean;
    verified?: boolean;
  }>;
  onSelect: (name: string) => void;
  selected: Set<string>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
      {items.map((i) => (
        <li key={i.name} className="flex items-baseline gap-2 px-3 py-2">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={selected.has(i.name)}
            onChange={() => onSelect(i.name)}
            disabled={i.installed && !i.updateAvailable}
          />
          <span className="font-medium text-foreground">{i.name}</span>
          {i.verified && (
            <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
              verified
            </span>
          )}
          {i.description ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{i.description}</span>
          ) : (
            <span className="flex-1" />
          )}
          <InstallBadge installed={i.installed} updateAvailable={i.updateAvailable} />
        </li>
      ))}
    </ul>
  );
}

export default function IntegrationsMarketplace() {
  const { catalog } = useLoaderData<typeof clientLoader>();

  const [scanUrl, setScanUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [catalogScan, setCatalogScan] = useState<MarketplaceCatalog | null>(catalog);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [scanError, setScanError] = useState<string>();
  const [installError, setInstallError] = useState<string>();
  const [installed, setInstalled] = useState<string[]>([]);

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!scanUrl.trim()) return;
    setScanning(true);
    setScanError(undefined);
    setScanResult(null);
    setCatalogScan(null);
    setSelected(new Set());
    try {
      const result = await scanIntegrations(scanUrl.trim());
      setScanResult(result);
    } catch (err) {
      setScanError(errMessage(err));
    } finally {
      setScanning(false);
    }
  }

  async function handleInstall() {
    const scanId = scanResult?.scanId ?? catalogScan?.scanId;
    if (!scanId || selected.size === 0) return;
    setInstalling(true);
    setInstallError(undefined);
    try {
      const result = await installIntegrations(scanId, [...selected]);
      setInstalled(result.installed);
      setSelected(new Set());
    } catch (err) {
      setInstallError(errMessage(err));
    } finally {
      setInstalling(false);
    }
  }

  const activeItems = scanResult?.integrations ?? catalogScan?.integrations ?? [];
  const installable = activeItems.filter((i) => !i.installed || i.updateAvailable);

  return (
    <ResourcePanel crumbs={[{ label: "integrations" }, { label: "marketplace" }]}>
      <IntegrationsTabs />

      <form onSubmit={handleScan} className="flex gap-2">
        <input
          className={inputClass}
          placeholder="owner/repo[#branch] or https://..."
          value={scanUrl}
          onChange={(e) => setScanUrl(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={scanning || !scanUrl.trim()}>
          {scanning ? "Scanning…" : "Scan"}
        </Button>
      </form>

      {scanError && <p className="text-sm text-destructive">{scanError}</p>}

      {activeItems.length > 0 && (
        <div className="flex flex-col gap-3">
          {catalogScan && !scanResult && (
            <p className="text-xs text-muted-foreground">
              Official integrations from{" "}
              <span className="font-medium text-foreground">{catalogScan.source}</span>
            </p>
          )}
          <IntegrationList items={activeItems} onSelect={toggleSelect} selected={selected} />
          {installable.length > 0 && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={installing || selected.size === 0}
                onClick={handleInstall}
              >
                {installing
                  ? "Installing…"
                  : selected.size > 0
                    ? `Install ${selected.size} integration${selected.size > 1 ? "s" : ""}`
                    : "Select integrations to install"}
              </Button>
              {installError && <p className="text-sm text-destructive">{installError}</p>}
            </div>
          )}
          {installed.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Installed: {installed.join(", ")} —{" "}
              <a href="/integrations" className="text-foreground underline">
                connect them now
              </a>
            </p>
          )}
        </div>
      )}

      {catalog === null && !scanResult && (
        <p className="text-sm text-muted-foreground">
          Official marketplace unavailable — enter a git URL above to scan a custom repo.
        </p>
      )}
    </ResourcePanel>
  );
}
