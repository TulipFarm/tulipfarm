import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { getSkill, removeSkill } from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Skills · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing skill name");
  const skill = await getSkill(name);
  return { skill };
}

export default function SkillDetail() {
  const { skill } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  // Two-click inline confirm — removal commits to the soul repo, so it needs an explicit confirm.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRemove() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await removeSkill(skill.name);
      navigate("/skills");
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed");
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <ResourcePanel crumbs={[{ label: "skills", to: "/skills" }, { label: skill.name }]}>
      {error ? (
        <p className="rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-destructive">
          error: {error}
        </p>
      ) : null}
      {skill.description ? <p className="text-muted-foreground">{skill.description}</p> : null}

      <dl className="flex flex-col rounded-sm border border-border">
        <div className="grid grid-cols-[8rem_1fr] gap-3 border-b border-border px-3 py-2">
          <dt className="text-muted-foreground">provenance</dt>
          <dd className="text-foreground">{skill.provenance}</dd>
        </div>
        {skill.source ? (
          <div className="grid grid-cols-[8rem_1fr] gap-3 px-3 py-2">
            <dt className="text-muted-foreground">source</dt>
            <dd className="min-w-0 break-words text-foreground">{skill.source}</dd>
          </div>
        ) : null}
      </dl>

      <Button
        size="sm"
        variant={confirming ? "destructive" : "outline"}
        className="self-start"
        disabled={busy}
        onClick={() => void onRemove()}
      >
        {busy ? "Removing…" : confirming ? "Confirm remove" : "Remove"}
      </Button>

      <div className="border-t border-border pt-4">
        <MarkdownView>{skill.body}</MarkdownView>
      </div>
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="skills" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="skills" status={status} message={message} />;
}
