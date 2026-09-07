import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import {
  type AdhocConnectionCandidate,
  getAdhocConnection,
  safeChatReturn,
} from "~/lib/connections";
import { usePublishPageTitle } from "~/lib/page-chrome-context";

export const meta: MetaFunction = () => [{ title: "Choose Connection · tulipfarm" }];

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const url = new URL(request.url);
  const rawOrigin = url.searchParams.get("origin");
  if (!rawOrigin) throw new ApiError(400, "This link does not name a destination.");

  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    origin = parsed.origin;
  } catch {
    throw new ApiError(400, "This link names an invalid destination.");
  }

  const match = await getAdhocConnection(origin);
  const candidates =
    match.state === "ambiguous"
      ? match.candidates
      : match.state === "match"
        ? [
            {
              connectionId: match.connectionId,
              label: match.label,
              ownerScope: match.ownerScope,
            },
          ]
        : [];
  return {
    origin,
    host: new URL(origin).host,
    returnTo: safeChatReturn(url.searchParams.get("return_to"), url),
    candidates,
  };
}

function scopeLabel(scope: AdhocConnectionCandidate["ownerScope"]): string {
  switch (scope) {
    case "personal":
      return "Personal";
    case "organization":
      return "Business";
    case "team":
      return "Team";
  }
}

export default function ChooseAdhocConnection() {
  const { origin, host, returnTo, candidates } = useLoaderData<typeof clientLoader>();
  usePublishPageTitle("Choose Connection");
  const [selectedId, setSelectedId] = useState(
    candidates.length === 1 ? candidates[0]?.connectionId : undefined
  );
  const [confirmed, setConfirmed] = useState<AdhocConnectionCandidate>();
  const selected = candidates.find((candidate) => candidate.connectionId === selectedId);
  const addParams = new URLSearchParams({ origin });
  if (returnTo) addParams.set("return_to", returnTo);

  if (confirmed) {
    const instruction = `Retry the request to ${origin} with connection_id="${confirmed.connectionId}" (${confirmed.label}).`;
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <h1 className="text-lg font-semibold">Connection chosen</h1>
        <FormStatus tone="success">
          {confirmed.label} is available for {host}. Its credential stays hidden.
        </FormStatus>
        <p className="text-sm text-muted-foreground">
          Copy this instruction, return to Chat, and send it so the Agent can retry with the exact
          Connection.
        </p>
        <CopyField value={instruction} label="retry instruction" />
        <Button asChild>
          <Link to={returnTo ?? "/"}>{returnTo ? "Return to Chat" : "Go to Chat"}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Choose a Connection</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {candidates.length > 1
            ? "More than one Connection can"
            : candidates.length === 1
              ? "This Connection can"
              : "No saved Connection can"}{" "}
          authenticate requests to <strong className="font-medium text-foreground">{host}</strong>.
        </p>
        <code className="mt-2 block break-all text-xs text-muted-foreground">{origin}</code>
      </div>

      {candidates.length === 0 ? (
        <Panel title="No usable Connections">
          <div className="space-y-3 px-4 pb-4">
            <p className="text-sm text-muted-foreground">
              Add a destination-bound credential before retrying this request.
            </p>
            <Button asChild>
              <Link to={`/business/connections/new?${addParams.toString()}`}>Add a Connection</Link>
            </Button>
          </div>
        </Panel>
      ) : (
        <Panel
          title="Available Connections"
          description="Only active Connections you are allowed to use are shown."
        >
          <form
            className="space-y-4 px-4 pb-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected) setConfirmed(selected);
            }}
          >
            <fieldset className="space-y-2">
              <legend className="sr-only">Connection</legend>
              {candidates.map((candidate) => (
                <label
                  key={candidate.connectionId}
                  className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <input
                    type="radio"
                    name="connection"
                    value={candidate.connectionId}
                    checked={selectedId === candidate.connectionId}
                    onChange={() => setSelectedId(candidate.connectionId)}
                    className="size-4 accent-foreground"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{candidate.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {scopeLabel(candidate.ownerScope)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Button type="submit" disabled={!selected}>
              Use this Connection
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="Connection" status={status} message={message} />;
}
