import { useNavigate } from "@remix-run/react";
import { useRef, useState } from "react";
import { Bot, Database, Info, Layers, MessageSquare, Sparkles, Workflow } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  type PackPreview,
  type PackSource,
  packChatLaunchError,
  packPlanPrompt,
  packPreviewLaunchError,
} from "~/lib/packs";
import { cn } from "~/lib/utils";
import { randomUUID } from "~/lib/uuid";
import { PACK_CATEGORY_STYLE, PackCategoryIcon } from "./pack-category";
import { PackIntegrationIdeas } from "./pack-integration-ideas";

const KIND_LABELS = {
  resource: "Resource type",
  skill: "Skill",
  agent: "Agent",
  surface: "Surface",
  routine: "Routine",
};
const KIND_ICONS = {
  resource: Database,
  skill: Sparkles,
  agent: Bot,
  surface: Layers,
  routine: Workflow,
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
  const categoryStyle = PACK_CATEGORY_STYLE[pack.category];
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
    <section aria-label="Pack preview" className="max-w-4xl overflow-hidden rounded-xl border">
      <div className={cn("flex items-start gap-4 px-5 py-6 sm:px-6", categoryStyle.background)}>
        <span className={cn("shrink-0 rounded-xl bg-background/80 p-3", categoryStyle.ink)}>
          <PackCategoryIcon category={pack.category} className="size-7" />
        </span>
        <div className="min-w-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            {pack.category} · Version {pack.version}
          </p>
          <h2 className="break-words text-xl font-semibold">{pack.title}</h2>
          <p className="text-sm text-muted-foreground">{pack.description}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{pack.name}</p>
        </div>
      </div>
      <div className="space-y-6 p-5 sm:p-6">
        <PackIntegrationIdeas name={pack.name} sourceUrl={preview.url ?? source.url} />
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Included assets ({pack.artifacts.length})</h3>
          <ul className="divide-y rounded-md border">
            {pack.artifacts.map((artifact, index) => {
              const Icon = KIND_ICONS[artifact.kind];
              return (
                <li
                  key={`${index}-${artifact.kind}-${artifact.name}`}
                  className="flex items-start gap-3 p-3"
                >
                  <span className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm font-medium">
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
                  </div>
                </li>
              );
            })}
          </ul>
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
        <div className="flex items-start gap-3 rounded-lg bg-card p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Validation checks the Pack format, not whether its content is safe. Only use sources you
            trust. The agent will inspect your existing assets and prepare an adapted plan in Chat.
            Nothing is installed here. Review the plan and explicitly confirm before any
            modifications. If the source changes, a new preview and confirmation are required.
          </p>
        </div>
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
          <MessageSquare />
          Prepare plan in Chat
        </Button>
      </div>
    </section>
  );
}
