import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { mcpError } from "~/components/integrations/mcp-form";
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
import {
  getMcpAccountConfiguration,
  listMcpAccounts,
  type McpAccountConfiguration,
} from "~/lib/mcp-accounts";
import { getMcpIntegration } from "~/lib/mcp-integrations";

export const meta: MetaFunction = () => [{ title: "Integration · tulipfarm" }];

type IntegrationDetailData =
  | {
      kind: "mcp";
      definition: McpIntegrationDefinition;
      accounts: { items: McpAccountSummary[]; error: string | null };
      configuration: { value: McpAccountConfiguration | null; error: string | null };
    }
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
    const [definition, accounts, configuration] = await Promise.all([
      getMcpIntegration(name),
      listMcpAccounts(name)
        .then((items) => ({ items, error: null }))
        .catch((error: unknown) => ({
          items: [],
          error: mcpError(error),
        })),
      getMcpAccountConfiguration(name)
        .then((value) => ({ value, error: null }))
        .catch((error: unknown) => ({
          value: null,
          error: mcpError(error),
        })),
    ]);
    return { kind: "mcp" as const, definition, accounts, configuration };
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
        key={data.definition.server.id}
        definition={data.definition}
        accounts={data.accounts.items}
        accountsError={data.accounts.error ?? undefined}
        accountConfiguration={data.configuration.value ?? undefined}
        configurationError={data.configuration.error ?? undefined}
        callbackStatus={
          params.get("status") === "connected" &&
          data.accounts.items.some(
            (account) => account.id === params.get("account") && account.status === "active"
          )
            ? "Account sign-in completed."
            : params.get("status") === "error"
              ? "Account authorization did not complete. Start the connection again."
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
