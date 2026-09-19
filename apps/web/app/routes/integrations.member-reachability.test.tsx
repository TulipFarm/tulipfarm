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
      reviewPolicy: "custom",
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
        if (path === "/api/v1/integration-setups") return response({ operations: [] });
        if (path === "/api/v1/integrations/support") return response({ server: definition });
        if (path === "/api/v1/integrations/support/setup")
          return response({
            definitionRevision: "c".repeat(64),
            policy: "preserve",
            publishedReady: true,
            canConfigure: false,
            canUseStandardAccess: false,
          });
        if (path === "/api/v1/integrations/support/accounts")
          return response(created ? [account] : []);
        if (path === "/api/v1/integrations/support/accounts/configuration")
          return response({
            authentication,
            requiredSlots: authentication === "token" ? ["accessToken"] : [],
            sharedAllowed: true,
            definitionDigest: "a".repeat(64),
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
      if (method === "POST" && /^\/api\/v1\/integration-setups\/[^/]+$/.test(path)) {
        created = true;
        return response({
          id: path.split("/").at(-1),
          integrationKey: "support",
          accountId: account.id,
          status: authentication === "oauth" ? "needs_sign_in" : "done",
        });
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
      const manage = await screen.findByRole("button", { name: "Connect Support" });
      expect(screen.queryByRole("button", { name: "Add integration" })).not.toBeInTheDocument();
      await userEvent.click(manage);
      expect(await screen.findByRole("dialog", { name: "Connect Support" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Connect Support" })).toBeInTheDocument();
    } else {
      await userEvent.click(await screen.findByText("Integration accounts"));
      await userEvent.click(screen.getByRole("link", { name: "Manage accounts" }));
    }

    await userEvent.click(await screen.findByText("Account preferences"));
    await userEvent.clear(screen.getByLabelText("Account name"));
    await userEvent.type(screen.getByLabelText("Account name"), "My support");
    await userEvent.click(screen.getByText("Advanced settings"));
    expect(screen.queryByRole("button", { name: "Edit settings" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Discover available access" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove integration" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Who can use this account?")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Enabled")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Enable|Disable) integration$/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Manage shared access")).not.toBeInTheDocument();

    if (authentication === "token") {
      await userEvent.type(screen.getByLabelText("Access token"), "fake-member-token");
      await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    } else {
      await userEvent.click(screen.getByText("Use an existing OAuth app"));
      await userEvent.type(await screen.findByLabelText("OAuth client ID"), "registered-client");
      await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    }
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/integration-setups\/[^/]+$/),
        expect.objectContaining({
          method: "POST",
          credentials: "include",
        })
      )
    );
    const submitted = fetchMock.mock.calls.find(
      ([url, init]) =>
        /\/api\/v1\/integration-setups\/[^/]+$/.test(String(url)) && init?.method === "POST"
    )?.[1];
    expect(JSON.parse(String(submitted?.body))).toEqual({
      integrationKey: "support",
      definitionRevision: "c".repeat(64),
      account: {
        label: "My support",
        scope: "personal",
        authentication,
        ...(authentication === "oauth"
          ? {
              oauthClient: { clientId: "registered-client", tokenEndpointAuthMethod: "none" },
            }
          : {}),
      },
      ...(authentication === "token" ? { values: { accessToken: "fake-member-token" } } : {}),
      initializePolicy: false,
    });
    if (authentication === "token") expect(await screen.findByText("Connected")).toBeVisible();
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
