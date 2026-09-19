import { createRemixStub } from "@remix-run/testing";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { McpIntegrationPanel } from "../app/components/integrations/mcp-integration-panel";
import { McpProviderSetup } from "../app/components/integrations/mcp-provider-setup";
import "../app/app.css";

const scenario = new URLSearchParams(window.location.search).get("scenario");

function Fixture() {
  const [done, setDone] = useState(false);
  return (
    <main className="mx-auto max-w-xl p-5">
      {done ? (
        <p role="status">Fixture complete</p>
      ) : scenario === "token" ? (
        <McpProviderSetup
          entry={{
            id: "github",
            name: "GitHub",
            publisher: "GitHub",
            url: "https://api.githubcopilot.com/mcp/",
            publisherEvidence: "https://github.com/github/github-mcp-server",
            authentication: ["token", "oauth"],
            setup: [],
            limitations: [],
            knowledgeSync: "excluded",
          }}
          onChanged={() => {}}
          onDone={() => setDone(true)}
        />
      ) : (
        <McpIntegrationPanel
          embedded
          serverId="github-mcp"
          onChanged={() => {}}
          onDone={() => setDone(true)}
        />
      )}
    </main>
  );
}

const Stub = createRemixStub([
  {
    id: "routes/_app",
    path: "/",
    loader: () => ({ user: { id: "fixture-user", isAdmin: true } }),
    Component: Fixture,
  },
]);
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing.");
createRoot(root).render(<Stub />);
