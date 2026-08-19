import { CheckCircle2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import {
  getPublicOrigins,
  getUpdateCheck,
  type PublicOrigins,
  resetPublicOrigins,
  savePublicOrigins,
  type UpdateCheck,
} from "~/lib/system";
import { useIsAdmin } from "~/lib/use-session-user";

export default function BusinessAbout() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [origins, setOrigins] = useState<PublicOrigins | null>(null);
  const [webOrigin, setWebOrigin] = useState("");
  const [apiOrigin, setApiOrigin] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const isAdmin = useIsAdmin();

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
    void getPublicOrigins().then((value) => {
      setOrigins(value);
      setWebOrigin(value.webOrigin);
      setApiOrigin(value.apiOrigin === value.webOrigin ? "" : value.apiOrigin);
    });
  }, [checkForUpdates]);

  const applyOrigins = (value: PublicOrigins) => {
    setOrigins(value);
    setWebOrigin(value.webOrigin);
    setApiOrigin(value.apiOrigin === value.webOrigin ? "" : value.apiOrigin);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      applyOrigins(await savePublicOrigins({ webOrigin, apiOrigin: apiOrigin || null }));
      setStatus({ tone: "success", message: "Public addresses updated." });
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Update failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setStatus(null);
    try {
      applyOrigins(await resetPublicOrigins());
      setStatus({ tone: "success", message: "Environment addresses restored." });
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Reset failed.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel>
        <div className="space-y-4 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Public address</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Used for integration callbacks, webhooks, and links shared outside this deployment.
            </p>
          </div>
          {status ? <FormStatus tone={status.tone}>{status.message}</FormStatus> : null}
          <Field label="Web address" help="For example, https://tulip.example.com">
            <Input
              value={webOrigin}
              onChange={(event) => setWebOrigin(event.target.value)}
              disabled={!isAdmin || origins?.locked || saving}
              placeholder="https://tulip.example.com"
            />
          </Field>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
            <Field
              className="mt-3"
              label="API address"
              help="Leave empty when the API uses the same public address."
            >
              <Input
                value={apiOrigin}
                onChange={(event) => setApiOrigin(event.target.value)}
                disabled={!isAdmin || origins?.locked || saving}
                placeholder="Same as web address"
              />
            </Field>
          </details>
          {origins ? (
            <Field label="OAuth callback URL" help="Copy this exact URL into the provider app.">
              <CopyField value={origins.callbackUrl} label="OAuth callback URL" />
            </Field>
          ) : null}
          {origins?.locked ? (
            <p className="text-xs text-muted-foreground">Managed by the deployment environment.</p>
          ) : isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save()} disabled={saving || !webOrigin.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {typeof window !== "undefined" ? (
                <Button
                  variant="outline"
                  onClick={() => setWebOrigin(window.location.origin)}
                  disabled={saving}
                >
                  Use this browser address
                </Button>
              ) : null}
              {origins?.source === "database" ? (
                <Button variant="outline" onClick={() => void reset()} disabled={saving}>
                  Restore environment value
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only an admin can change this address.</p>
          )}
        </div>
      </Panel>
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
    </div>
  );
}
