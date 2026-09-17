import { useParams, useRevalidator, useRouteError } from "@remix-run/react";
import { PageShell } from "~/components/page-shell";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";

type ResourceErrorSubject = "catalog" | "resource-type" | "record";

function isConnectionFailure(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /failed to fetch|networkerror|network request failed|load failed/i.test(error.message)
  );
}

function isMissingResourceType(error: ApiError, subject: ResourceErrorSubject): boolean {
  return (
    subject === "resource-type" ||
    error.message === "missing resource type" ||
    error.message.startsWith("resource type not found")
  );
}

export function ResourceRouteError({ subject }: { subject: ResourceErrorSubject }) {
  const error = useRouteError();
  const { type } = useParams();
  const revalidator = useRevalidator();
  const retrying = revalidator.state !== "idle";
  const apiError = error instanceof ApiError ? error : null;
  const missingType = apiError?.status === 404 && isMissingResourceType(apiError, subject);
  const missingRecord = apiError?.status === 404 && subject === "record" && !missingType;

  let title = "Resources could not be loaded.";
  let guidance =
    "Try again to reload this page. If the problem continues, contact your administrator.";

  if (missingType) {
    title = "Resource type not found.";
    guidance = "This Resource type does not exist or is no longer available.";
  } else if (missingRecord) {
    title = "Record not found.";
    guidance = "No Record matches this ID. It may have been deleted.";
  } else if (apiError?.status === 401) {
    title = "Authentication required.";
    guidance = "Sign in again, then try loading Resources.";
  } else if (apiError?.status === 403) {
    title = "Resources are not available to your account.";
    guidance = "Check your access, then try again.";
  } else if (isConnectionFailure(error)) {
    guidance = "Check your connection, then try again.";
  }

  const backToType = subject === "record" && type && !missingType;
  const backPath = backToType ? `/resources/${encodeURIComponent(type)}` : "/resources";
  const showBack = subject !== "catalog";

  return (
    <PageShell title="Resources">
      <div className="flex max-w-prose flex-col gap-3 text-sm">
        <p role="alert" className="text-destructive">
          {title}
        </p>
        <p className="text-muted-foreground">{guidance}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={retrying} onClick={() => revalidator.revalidate()}>
            {retrying ? "Trying again…" : "Try again"}
          </Button>
          {showBack ? (
            <Button asChild variant="outline">
              <Link to={backPath}>{backToType ? `Back to ${type}` : "Back to Resources"}</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}
