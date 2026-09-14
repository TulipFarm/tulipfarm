import { useLoaderData, useRouteError } from "@remix-run/react";
import { useRef, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { TelemetryDisclosure, TelemetryLevelPicker } from "~/components/settings/telemetry-level";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Panel } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import {
  getTelemetry,
  saveTelemetry,
  type TelemetryLevel,
  type TelemetrySettings,
} from "~/lib/telemetry";
import { useIsAdmin } from "~/lib/use-session-user";

export async function clientLoader() {
  return getTelemetry();
}

export default function TelemetryRoute() {
  const initial = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">
        Only an administrator can view telemetry settings.
      </p>
    );
  return <TelemetryPanel initial={initial} />;
}

function TelemetryPanel({ initial }: { initial: TelemetrySettings }) {
  const [saved, setSaved] = useState(initial);
  const [level, setLevel] = useState<TelemetryLevel>(
    Math.min(initial.level, initial.maxLevel) as TelemetryLevel
  );
  const [preview, setPreview] = useState<TelemetrySettings | null>(initial);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const request = useRef(0);
  const dirty = !saved.configured || level !== saved.level;

  async function loadPreview(next: TelemetryLevel) {
    const current = ++request.current;
    setLevel(next);
    setPreview(null);
    setPreviewing(true);
    setError(null);
    setDone(false);
    try {
      const result = await getTelemetry(next);
      if (current === request.current) setPreview(result);
    } catch (err) {
      if (current === request.current)
        setError(err instanceof Error ? err.message : "Could not load the preview.");
    } finally {
      if (current === request.current) setPreviewing(false);
    }
  }

  async function save() {
    if (saving || !preview || previewing) return;
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      const result = await saveTelemetry(level);
      setSaved(result);
      setLevel(Math.min(result.level, result.maxLevel) as TelemetryLevel);
      setPreview(result);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the preference.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-5">
      <TelemetryDisclosure />
      {!saved.enabled ? (
        <p className="text-sm text-muted-foreground">
          Telemetry delivery is disabled in development and tests. Your preference is still saved.
        </p>
      ) : null}
      {!saved.configured ? (
        <p className="text-sm text-muted-foreground">
          Daily reports are paused until you save a preference. Existing installations still send
          the mandatory bootstrap report.
        </p>
      ) : null}
      <Panel
        title="Sharing preference"
        footer={
          <Button onClick={() => void save()} disabled={!dirty || saving || previewing || !preview}>
            {saving ? "Saving…" : "Save preference"}
          </Button>
        }
      >
        <div className="space-y-4">
          <TelemetryLevelPicker
            value={level}
            maxLevel={saved.maxLevel}
            onChange={(next) => void loadPreview(next)}
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            Saved level: {saved.level}. Effective saved level: {saved.effectiveLevel}.
            {saved.configured && saved.effectiveLevel === 0 ? " Daily reporting is off." : ""}
          </p>
          {error ? <FormStatus tone="error">{error}</FormStatus> : null}
          {done ? <FormStatus tone="success">Telemetry preference saved.</FormStatus> : null}
        </div>
      </Panel>
      <Panel
        title="Payload preview"
        description="The server-generated JSON for this selection. Previewing sends nothing to the collector."
      >
        {previewing ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading preview…
          </p>
        ) : preview ? (
          <div className="min-w-0 space-y-4">
            <p className="text-xs text-muted-foreground">
              Effective preview level: {preview.effectiveLevel}. Event IDs and timestamps are
              assigned to new reports; daily values can change before delivery.
            </p>
            <Payload
              label="Bootstrap payload"
              value={preview.preview.bootstrap}
              empty="No bootstrap payload is available yet."
            />
            <Payload
              label="Daily payload"
              value={preview.preview.snapshot}
              empty="No daily report for this selection."
            />
          </div>
        ) : (
          <Button variant="outline" onClick={() => void loadPreview(level)}>
            Retry preview
          </Button>
        )}
      </Panel>
      <Panel title="Reporting history">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Installation ID</dt>
            <dd className="break-all font-mono text-xs">{saved.installationId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Bootstrap delivered</dt>
            <dd>
              <ReportTime value={saved.bootstrapSentAt} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last daily report delivered</dt>
            <dd>
              <ReportTime value={saved.lastSnapshotAt} />
            </dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}

function Payload({
  label,
  value,
  empty,
}: {
  label: string;
  value: Record<string, unknown> | null;
  empty: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-medium">{label}</h3>
      {value ? (
        <section
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The payload scroll region must support keyboard scrolling.
          tabIndex={0}
          className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs"
        >
          <pre>{JSON.stringify(value, null, 2)}</pre>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function ReportTime({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    <>Not delivered yet</>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <ErrorState
      section="settings"
      status={error instanceof ApiError ? error.status : undefined}
      message={error instanceof Error ? error.message : undefined}
    />
  );
}
