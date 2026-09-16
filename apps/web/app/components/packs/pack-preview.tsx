import { useNavigate } from "@remix-run/react";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  type PackPreview,
  type PackSource,
  packChatLaunchError,
  packPlanPrompt,
  packPreviewLaunchError,
} from "~/lib/packs";
import { randomUUID } from "~/lib/uuid";

const KIND_LABELS = {
  resource: "Resource type",
  skill: "Skill",
  agent: "Agent",
  surface: "Surface",
  routine: "Routine",
};

export function PackPreviewPanel({
  preview,
  source,
}: {
  preview: PackPreview;
  source: PackSource;
}) {
  const navigate = useNavigate();
  const launching = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { pack, sha256 } = preview;
  const prompt = packPlanPrompt(preview, source);
  const launchError = packPreviewLaunchError(preview) ?? packChatLaunchError(prompt);

  function preparePlan() {
    if (launching.current || launchError) return;
    launching.current = true;
    setError(null);
    try {
      navigate("/", {
        state: {
          chatLaunch: { id: randomUUID(), prompt, mode: "plan" },
        },
      });
    } catch {
      launching.current = false;
      setError("Could not open Chat. Your preview is still here; try again.");
    }
  }

  return (
    <section aria-label="Pack preview" className="max-w-3xl space-y-5 rounded-lg border p-4 sm:p-5">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {pack.category} · Version {pack.version}
        </p>
        <h2 className="text-base font-semibold">{pack.title}</h2>
        <p className="text-sm text-muted-foreground">{pack.description}</p>
        <p className="font-mono text-xs text-muted-foreground">{pack.name}</p>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Requirements</h3>
        {pack.requirements?.length ? (
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {pack.requirements.map((requirement, index) => (
              <li key={`${index}-${requirement}`}>{requirement}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None declared.</p>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Included assets ({pack.artifacts.length})</h3>
        <ul className="divide-y rounded-md border">
          {pack.artifacts.map((artifact, index) => (
            <li key={`${index}-${artifact.kind}-${artifact.name}`} className="space-y-1 p-3">
              <p className="text-sm font-medium">
                {artifact.name}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {KIND_LABELS[artifact.kind]}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">{artifact.description}</p>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  View template
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
                  {JSON.stringify(artifact.template, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium">View original plan</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3 text-xs">
          {JSON.stringify(pack.plan, null, 2)}
        </pre>
      </details>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="font-medium">Source</dt>
          <dd className="break-all text-muted-foreground">
            {preview.url ?? source.url ?? "Pasted YAML"}
          </dd>
        </div>
        <div>
          <dt className="font-medium">SHA-256</dt>
          <dd className="break-all font-mono text-muted-foreground">{sha256}</dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">
        Validation checks the Pack format, not whether its content is safe. Only use sources you
        trust. The agent will inspect your existing assets and prepare an adapted plan in Chat.
        Nothing is installed here. Review the plan and explicitly confirm before any modifications.
        If the source changes, a new preview and confirmation are required.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {launchError ? (
        <p role="alert" className="text-sm text-destructive">
          {launchError}
        </p>
      ) : null}
      <Button onClick={preparePlan} disabled={launchError !== null}>
        Prepare plan in Chat
      </Button>
    </section>
  );
}
