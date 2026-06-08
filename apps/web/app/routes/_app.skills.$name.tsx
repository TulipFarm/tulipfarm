import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useParams,
  useRouteError,
} from "@remix-run/react";
import { MarkdownView } from "~/components/markdown-view";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getSkill } from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Skills · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing skill name");
  const skill = await getSkill(name);
  return { skill };
}

export default function SkillDetail() {
  const { skill } = useLoaderData<typeof clientLoader>();

  return (
    <ResourcePanel
      crumbs={[{ label: "skills", to: "/skills" }, { label: skill.name }]}
      command={`tulipfarm skills show ${skill.name}`}
    >
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

      <div className="border-t border-border pt-4">
        <MarkdownView>{skill.body}</MarkdownView>
      </div>
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();
  const command = `tulipfarm skills show ${params.name ?? ""}`;
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="skills" command={command} />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="skills" command={command} status={status} message={message} />;
}
