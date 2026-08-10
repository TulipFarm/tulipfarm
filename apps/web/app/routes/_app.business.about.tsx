import { CheckCircle2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Panel } from "~/components/ui/panel";
import { getUpdateCheck, type UpdateCheck } from "~/lib/system";

export default function BusinessAbout() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await getUpdateCheck());
    } catch {
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  return (
    <Panel
      flush
      footer={
        <span className="text-xs text-muted-foreground">
          Installation and update controls will live here when in-app updates are available.
        </span>
      }
    >
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">TulipFarm</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Version {check?.version ?? __APP_VERSION__}
          </p>
          {check?.updateAvailable && check.latest ? (
            <p className="mt-2 text-sm text-foreground">Version {check.latest} is available.</p>
          ) : check ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <CheckCircle2 aria-hidden className="size-4 text-status-success" />
              You are up to date.
            </p>
          ) : null}
        </div>
        <Button variant="outline" onClick={() => void checkForUpdates()} disabled={checking}>
          <RefreshCw aria-hidden className={checking ? "animate-spin" : undefined} />
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </div>
    </Panel>
  );
}
