import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import {
  loadMcpIntegrationData,
  type McpIntegrationData,
} from "~/components/integrations/mcp-integration-data";
import { McpServerDetail } from "~/components/integrations/mcp-server-detail";
import { NativeChannelDetail } from "~/components/integrations/native-channel-detail";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import {
  type GitHubInstallation,
  getGitHubStatus,
  getIntegration,
  type IntegrationDetail,
  listSlackRoutes,
} from "~/lib/integrations";

export const meta: MetaFunction = () => [{ title: "Integration · tulipfarm" }];

type IntegrationDetailData =
  | ({ kind: "mcp" } & McpIntegrationData)
  | {
      kind: "channel";
      integration: IntegrationDetail;
      installations: GitHubInstallation[];
      routesError: string | null;
    };

export async function clientLoader({
  params,
  request,
}: ClientLoaderFunctionArgs): Promise<IntegrationDetailData> {
  const name = params.name;
  if (!name) throw new ApiError(404, "Missing Integration name.");
  if (
    name !== "slack" &&
    name !== "github" &&
    new URL(request.url).searchParams.get("channel") !== "1"
  ) {
    return { kind: "mcp" as const, ...(await loadMcpIntegrationData(name)) };
  }
  if (name !== "slack" && name !== "github") throw new ApiError(404, "Channel not found.");
  const integration = await getIntegration(name);
  let installations: GitHubInstallation[] = [];
  let routesError: string | null = null;
  try {
    if (name === "github") installations = await getGitHubStatus();
    if (name === "slack" && integration.connected) await listSlackRoutes();
  } catch (error) {
    routesError = error instanceof Error ? error.message : "Channel status could not be loaded.";
  }
  return { kind: "channel" as const, integration, installations, routesError };
}

export default function IntegrationDetailPage() {
  const data = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  if (data.kind === "mcp")
    return (
      <McpServerDetail
        key={`${data.definition.server.id}:${params.get("account") ?? ""}`}
        definition={data.definition}
        accounts={data.accounts.items}
        accountsError={data.accounts.error ?? undefined}
        accountConfiguration={data.configuration.value ?? undefined}
        configurationError={data.configuration.error ?? undefined}
        eligibility={data.eligibility.value ?? undefined}
        eligibilityError={data.eligibility.error ?? undefined}
        refreshing={revalidator.state === "loading"}
        callbackAccountId={params.get("account") ?? undefined}
        callbackStatus={
          params.get("status") === "connected" &&
          data.accounts.items.some(
            (account) => account.id === params.get("account") && account.status === "active"
          )
            ? "Account sign-in completed."
            : undefined
        }
        callbackError={
          params.get("status") === "error"
            ? "Provider sign-in did not complete. Continue sign-in on your saved account below."
            : undefined
        }
        onChanged={() => revalidator.revalidate()}
        onRemoved={() => navigate("/integrations")}
      />
    );
  const { integration, installations, routesError } = data;
  return (
    <NativeChannelDetail
      key={integration.name}
      integration={integration}
      installations={installations}
      routesError={routesError ?? undefined}
      callbackError={
        params.get("status") === "error"
          ? "Account authorization did not complete. Start the connection again."
          : undefined
      }
      onChanged={() => revalidator.revalidate()}
    />
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404)
    return <NotFoundState section="integrations" />;
  return (
    <ErrorState
      section="integrations"
      status={error instanceof ApiError ? error.status : undefined}
      message={error instanceof Error ? error.message : undefined}
    />
  );
}
