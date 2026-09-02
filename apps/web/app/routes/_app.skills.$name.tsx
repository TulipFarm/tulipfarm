import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { PageShell } from "~/components/page-shell";
import { SkillAudiencePanel } from "~/components/skills/audience-panel";
import { SkillCapabilityPanel } from "~/components/skills/capability-panel";
import { SkillPackagePanel } from "~/components/skills/package-panel";
import { SkillReachBadge } from "~/components/skills/reach-badge";
import { ErrorState, NotFoundState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { listAgents } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import { skillFacts } from "~/lib/skill-facts";
import { getSkill, removeSkill } from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Skills · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing skill name");
  // The audience panel is a nicety; a Skill must still open when the agent roster cannot be read.
  const [skill, agents] = await Promise.all([getSkill(name), listAgents().catch(() => [])]);
  return { skill, agents };
}

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-xs text-foreground">{value}</dd>
    </div>
  );
}

export default function SkillDetail() {
  const { skill, agents } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  // Two-click inline confirm — removal commits to the soul repo, so it needs an explicit confirm.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const facts = skillFacts(skill);

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
    <PageShell
      crumbs={[{ label: "Skills", to: "/skills" }, { label: skill.name }]}
      title={skill.name}
      description={skill.description}
      meta={
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-xs text-muted-foreground">reach</dt>
            <dd>
              <SkillReachBadge reach={facts.reach} />
            </dd>
          </div>
          <Fact label="category" value={skill.category} />
          <Fact label="from" value={skill.provenance} />
          <Fact label="version" value={skill.version} />
          <Fact label="author" value={skill.author} />
          <Fact label="license" value={skill.license} />
          <Fact label="source" value={skill.source} />
        </dl>
      }
      actions={
        <Button
          size="sm"
          variant={confirming ? "destructive" : "outline"}
          disabled={busy}
          onClick={() => void onRemove()}
        >
          {busy ? "Removing…" : confirming ? "Confirm remove" : "Remove"}
        </Button>
      }
    >
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          This skill could not be removed. {error}
        </p>
      ) : null}
      {confirming && !busy ? (
        <p
          role="status"
          className="rounded-sm border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          Removing {skill.name} deletes it from this business and records the change in the soul
          history. Press Remove again to confirm, or{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setConfirming(false)}
          >
            cancel
          </button>
          .
        </p>
      ) : null}

      <SkillCapabilityPanel facts={facts} />

      <Panel
        flush
        title="What it can run"
        description={
          skill.commands.length > 0
            ? "Commands this skill ships, each run in an isolated sandbox."
            : undefined
        }
      >
        {skill.commands.length === 0 ? (
          <PanelEmpty>
            This skill runs nothing. It is instructions the agent reads and acts on itself.
          </PanelEmpty>
        ) : (
          <ul className="flex flex-col">
            {skill.commands.map((command) => (
              <li
                key={command.name}
                className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-foreground">{command.name}</span>
                  <Badge variant={command.runtimeAvailable ? "success" : "danger"}>
                    {command.runtimeAvailable ? "Ready to run" : "Cannot run"}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {command.runtimeProfile} · {command.entrypoint}
                </p>
                {command.requiredCommands.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Needs these programs in the sandbox: {command.requiredCommands.join(", ")}
                  </p>
                ) : null}
                {command.blocker ? (
                  <p className="text-xs text-status-danger">{command.blocker}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <SkillPackagePanel skillName={skill.name} files={skill.files} />

      <SkillAudiencePanel skillName={skill.name} agents={agents} />

      {/*
        No panel title here: the skill's own markdown opens with its own headings, and a frame
        title would outrank nothing while looking smaller than the headings it contains.
      */}
      <Panel description="The instructions an agent is given when it loads this skill, exactly as written.">
        <MarkdownView>{skill.body}</MarkdownView>
      </Panel>

      <p className="text-sm text-muted-foreground">
        Want this to do something else?{" "}
        <Link to="/?agent=skill-forge" className="underline underline-offset-2">
          Ask skill forge to change it
        </Link>
        .
      </p>
    </PageShell>
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
