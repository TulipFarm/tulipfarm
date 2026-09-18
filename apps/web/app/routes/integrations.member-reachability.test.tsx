import { Outlet } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { afterEach, expect, test, vi } from "vitest";
import { ChatIntegrationAccounts } from "~/components/chat/integration-accounts";
import { API_BASE, type SessionUser } from "~/lib/api";
import { clientLoader as sessionLoader } from "./_app";
import IntegrationsIndex, { clientLoader as integrationsLoader } from "./_app.integrations._index";
import IntegrationDetailPage, { clientLoader as detailLoader } from "./_app.integrations.$name";
import SettingsIndex from "./_app.settings._index";

const member: SessionUser = {
  id: "member",
  email: "muskan@example.com",
  name: "Muskan Vijayvargiya",
  role: "member",
  status: "active",
  isAdmin: false,
  navigation: { visiblePaths: ["/integrations"] },
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function serverLoader(): Promise<never> {
  throw new Error("This SPA must not invoke a server loader.");
}

afterEach(() => vi.unstubAllGlobals());

test.each<{ entry: "settings" | "chat"; authentication: "token" | "oauth" }>([
  { entry: "settings", authentication: "token" },
  { entry: "chat", authentication: "oauth" },
])(
  "a member reaches personal $authentication setup from $entry without admin controls",
  async ({ entry, authentication }) => {
    const definition: McpIntegrationDefinition = {
      server: {
        id: "support",
        label: "Support",
        transport: { type: "streamable-http", url: "https://mcp.example.com/" },
        authentication: { type: authentication, sharedAllowed: true },
      },
      enabled: true,
      reviewed: { tools: [], resources: [], prompts: [] },
    };
    const account: McpAccountSummary = {
      id: "my-account",
      integrationKey: "support",
      businessId: "business",
      definitionDigest: "a".repeat(64),
      label: "My support",
      owner: { scope: "personal", principalId: member.id },
      authentication,
      oauthClient:
        authentication === "oauth"
          ? { clientId: "registered-client", tokenEndpointAuthMethod: "none" }
          : undefined,
      status: authentication === "token" ? "active" : "pending",
      isDefault: false,
      revision: 1,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
    };
    const callbackUrl = "https://operator.example/api/v1/accounts/my-account/callback";
    let created = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET") {
        if (path === "/api/v1/setup/status")
          return response({ needsSetup: false, telemetry: { maxLevel: "off", enabled: false } });
        if (path === "/api/v1/auth/session") return response({ user: member });
        if (path === "/api/v1/integrations") return response({ servers: [definition] });
        if (path === "/api/v1/integrations/catalog") return response({ entries: [] });
        if (path === "/api/v1/integrations/support") return response({ server: definition });
        if (path === "/api/v1/integrations/support/accounts")
          return response(created ? [account] : []);
        if (path === "/api/v1/integrations/support/accounts/configuration")
          return response({
            authentication,
            requiredSlots: authentication === "token" ? ["accessToken"] : [],
            sharedAllowed: true,
          });
        if (path === "/api/v1/integrations/support/accounts/my-account/oauth/configuration")
          return response({ callbackUrl });
        if (path === "/api/v1/chats/chat-1/integrations/support/account")
          return response({ error: "account_selection_required" }, 409);
        if (
          path === "/api/v1/integrations/native/slack" ||
          path === "/api/v1/integrations/native/github"
        )
          return response({
            name: path.endsWith("slack") ? "slack" : "github",
            connected: false,
            auth: [],
            manifest: {},
          });
      }
      if (method === "POST" && path === "/api/v1/integrations/support/accounts") {
        created = true;
        return response(account, 201);
      }
      if (
        method === "POST" &&
        path === "/api/v1/integrations/support/accounts/my-account/oauth/start"
      )
        return response({ error: "oauth_failed" }, 502);
      throw new Error(`Unexpected member request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const Stub = createRemixStub([
      {
        id: "routes/_app",
        path: "/",
        Component: Outlet,
        loader: ({ request, params }) =>
          sessionLoader({ request, params, context: undefined, serverLoader }),
        children: [
          { path: "settings", Component: SettingsIndex },
          {
            path: "chat/chat-1",
            Component: () => <ChatIntegrationAccounts chatId="chat-1" disabled={false} />,
          },
          {
            path: "integrations",
            Component: IntegrationsIndex,
            loader: integrationsLoader,
          },
          {
            path: "integrations/:name",
            Component: IntegrationDetailPage,
            loader: ({ request, params }) =>
              detailLoader({ request, params, context: undefined, serverLoader }),
          },
        ],
      },
    ]);
    render(<Stub initialEntries={[entry === "settings" ? "/settings" : "/chat/chat-1"]} />);
    if (entry === "settings") {
      const manage = await screen.findByRole("link", { name: "Manage Support" });
      expect(screen.queryByRole("button", { name: "Add MCP server" })).not.toBeInTheDocument();
      await userEvent.click(manage);
    } else {
      await userEvent.click(await screen.findByText("Integration accounts"));
      await userEvent.click(screen.getByRole("link", { name: "Manage accounts" }));
    }

    await userEvent.type(await screen.findByLabelText("Account label"), "My support");
    expect(screen.queryByRole("button", { name: "Edit server" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discover capabilities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove server" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Account ownership")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Enabled")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage shared access")).not.toBeInTheDocument();

    if (authentication === "token") {
      await userEvent.type(screen.getByLabelText("Access token"), "fake-member-token");
      await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
    } else {
      await userEvent.click(screen.getByText("Use an existing OAuth app"));
      await userEvent.type(await screen.findByLabelText("OAuth client ID"), "registered-client");
      await userEvent.click(screen.getByRole("button", { name: "Save OAuth account" }));
    }
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_BASE}/api/v1/integrations/support/accounts`,
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({
            label: "My support",
            scope: "personal",
            authentication,
            ...(authentication === "token"
              ? { isDefault: false, values: { accessToken: "fake-member-token" } }
              : {
                  oauthClient: { clientId: "registered-client", tokenEndpointAuthMethod: "none" },
                }),
          }),
        })
      )
    );
    expect(await screen.findByText("My support")).toBeInTheDocument();
    if (authentication === "oauth") {
      expect(await screen.findByLabelText("OAuth callback URL")).toHaveValue(callbackUrl);
      await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Provider authorization did not complete. Start browser sign-in again."
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_BASE}/api/v1/integrations/support/accounts/my-account/oauth/start`,
        expect.objectContaining({ method: "POST", credentials: "include", body: "{}" })
      );
    }
  }
);
