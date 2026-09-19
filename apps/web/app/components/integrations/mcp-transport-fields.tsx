import type { McpTransport } from "@tulipfarm/schema";
import { Input } from "~/components/ui/input";
import { IntegrationChoice } from "./integration-choice";
import { McpField } from "./mcp-form";

export type TransportDraft = {
  type: McpTransport["type"];
  url: string;
  image: string;
  command: string;
  args: string;
  allowedEgress: string;
};

export function transportDraft(transport?: McpTransport): TransportDraft {
  return {
    type: transport?.type ?? "streamable-http",
    url: transport?.type === "streamable-http" ? transport.url : "",
    image: transport?.type === "stdio" ? transport.image : "",
    command: transport?.type === "stdio" ? transport.command : "",
    args: transport?.type === "stdio" ? transport.args.join("\n") : "",
    allowedEgress: transport?.type === "stdio" ? transport.allowedEgress.join("\n") : "",
  };
}

export function transportInput(draft: TransportDraft): McpTransport {
  if (draft.type === "streamable-http") {
    const url = new URL(draft.url.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) =>
        /^(access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|secret|client[_-]?secret|authorization|password)$/i.test(
          key
        )
      )
    ) {
      throw new Error(
        "Use an HTTPS integration URL without credentials or a fragment. Add access tokens when connecting an account."
      );
    }
    return { type: "streamable-http", url: url.toString() };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(draft.image.trim())) {
    throw new Error("Use a container image pinned to its sha256 digest.");
  }
  if (!draft.command.trim().startsWith("/")) {
    throw new Error("Use an absolute executable path inside the isolated container.");
  }
  const allowedEgress = draft.allowedEgress
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedEgress.some((host) => !/^[a-zA-Z0-9.-]+$/.test(host))) {
    throw new Error("Enter one outbound hostname per line, without a URL or wildcard.");
  }
  return {
    type: "stdio",
    image: draft.image.trim(),
    command: draft.command.trim(),
    args: draft.args ? draft.args.split("\n") : [],
    allowedEgress: [...new Set(allowedEgress)],
  };
}

export function McpTransportFields({
  value,
  onChange,
  disabled,
  showUrl = true,
}: {
  value: TransportDraft;
  onChange: (value: TransportDraft) => void;
  disabled?: boolean;
  showUrl?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <McpField label="Where it runs">
        <IntegrationChoice
          label="Where it runs"
          value={value.type}
          options={[
            { value: "streamable-http", label: "Hosted by the provider" },
            { value: "stdio", label: "On your infrastructure" },
          ]}
          onChange={(type) => {
            if (type === "streamable-http" || type === "stdio") onChange({ ...value, type });
          }}
        />
      </McpField>
      {value.type === "streamable-http" ? (
        showUrl && (
          <McpField
            label="Integration URL"
            hint="The MCP address supplied by the provider, not its website. Never include an access token."
          >
            <Input
              type="url"
              required
              value={value.url}
              onChange={(event) => onChange({ ...value, url: event.target.value })}
              placeholder="https://mcp.example.com/mcp"
            />
          </McpField>
        )
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Runs in an isolated runtime, never directly on the host. Production requires
            operator-configured Kata VM isolation on supported Linux/KVM, with no ordinary-container
            fallback. The host environment is not inherited; only reviewed outbound hosts are
            allowed.
          </p>
          <McpField label="Pinned container image">
            <Input
              required
              value={value.image}
              onChange={(event) => onChange({ ...value, image: event.target.value })}
              placeholder="registry.example.com/mcp@sha256:..."
            />
          </McpField>
          <McpField label="Executable path">
            <Input
              required
              value={value.command}
              onChange={(event) => onChange({ ...value, command: event.target.value })}
              placeholder="/app/server"
            />
          </McpField>
          <McpField
            label="Arguments"
            hint="One argument per line. Do not put secrets in arguments."
          >
            <textarea
              className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
              value={value.args}
              onChange={(event) => onChange({ ...value, args: event.target.value })}
            />
          </McpField>
          <McpField
            label="Allowed outbound hosts"
            hint="One hostname per line. Leave empty to deny outbound network access."
          >
            <textarea
              className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
              value={value.allowedEgress}
              onChange={(event) => onChange({ ...value, allowedEgress: event.target.value })}
            />
          </McpField>
        </>
      )}
    </fieldset>
  );
}
