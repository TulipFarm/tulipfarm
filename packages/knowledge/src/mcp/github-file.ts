import { canonicalHash } from "@tulipfarm/schema";
import {
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  type GithubKnowledgeFile,
  MCP_KNOWLEDGE_MAX_FILE_BYTES,
  type McpKnowledgeBinding,
  type McpKnowledgeDocument,
  McpKnowledgeError,
  type McpKnowledgeReadPort,
} from "./types";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sameMcpKnowledgeBinding(
  expected: McpKnowledgeBinding,
  actual: McpKnowledgeBinding
): boolean {
  return (
    expected.businessId === actual.businessId &&
    expected.integrationId === actual.integrationId &&
    expected.accountId === actual.accountId &&
    expected.accountRevision === actual.accountRevision &&
    expected.ownerUserId === actual.ownerUserId &&
    expected.externalAccountId === actual.externalAccountId &&
    expected.configurationRevision === actual.configurationRevision
  );
}

export function validateGithubKnowledgeFile(file: GithubKnowledgeFile): void {
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/.test(file.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(file.repo) ||
    file.owner === "." ||
    file.owner === ".." ||
    file.repo === "." ||
    file.repo === ".." ||
    !/^[A-Za-z0-9_./ -]+\.(md|txt)$/.test(file.path) ||
    file.path.length > 1024 ||
    file.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(file.ref) ||
    file.ref.length > 255 ||
    file.ref.includes("..")
  ) {
    throw new McpKnowledgeError("invalid_selection");
  }
}

export function mcpKnowledgeSourceId(
  binding: McpKnowledgeBinding,
  file: GithubKnowledgeFile,
  selectionId: string
): string {
  return `mcp:${canonicalHash({
    businessId: binding.businessId,
    integrationId: binding.integrationId,
    accountId: binding.accountId,
    file,
    selectionId,
  })}`;
}

export function parseGithubKnowledgeIdentity(response: {
  readonly isError?: boolean;
  readonly content: readonly unknown[];
}): string {
  if (response.isError) throw new McpKnowledgeError("source_unavailable");
  if (response.content.length !== 1) throw new McpKnowledgeError("source_response_invalid");
  const part = response.content[0];
  if (
    !object(part) ||
    part.type !== "text" ||
    typeof part.text !== "string" ||
    Buffer.byteLength(part.text, "utf8") > MCP_KNOWLEDGE_MAX_FILE_BYTES
  ) {
    throw new McpKnowledgeError("source_response_invalid");
  }
  let identity: unknown;
  try {
    identity = JSON.parse(part.text);
  } catch {
    throw new McpKnowledgeError("source_response_invalid");
  }
  if (
    !object(identity) ||
    typeof identity.id !== "number" ||
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0
  ) {
    throw new McpKnowledgeError("identity_mismatch");
  }
  return String(identity.id);
}

export async function readGithubKnowledgeFile(
  port: McpKnowledgeReadPort,
  binding: McpKnowledgeBinding,
  file: GithubKnowledgeFile,
  signal: AbortSignal = AbortSignal.timeout(30_000)
): Promise<McpKnowledgeDocument> {
  validateGithubKnowledgeFile(file);
  const supported =
    port.server.distribution === "github-official-local" &&
    port.server.revision === GITHUB_KNOWLEDGE_SERVER_REVISION;
  if (!supported) {
    throw new McpKnowledgeError("unsupported_source");
  }
  if (
    !sameMcpKnowledgeBinding(binding, port.binding) ||
    port.readerUserId !== binding.ownerUserId
  ) {
    throw new McpKnowledgeError("identity_mismatch");
  }
  signal.throwIfAborted();
  const me = await port.callTool({ name: "get_me", arguments: {}, signal });
  if (parseGithubKnowledgeIdentity(me) !== binding.externalAccountId) {
    throw new McpKnowledgeError("identity_mismatch");
  }
  signal.throwIfAborted();
  const result = await port.callTool({
    name: "get_file_contents",
    arguments: { owner: file.owner, repo: file.repo, path: file.path, ref: file.ref },
    signal,
  });
  if (result.isError) throw new McpKnowledgeError("source_unavailable");
  if (result.content.length !== 2) throw new McpKnowledgeError("source_response_invalid");
  const [message, part] = result.content;
  if (object(part) && part.type === "resource_link")
    throw new McpKnowledgeError("source_too_large");
  if (
    !object(message) ||
    message.type !== "text" ||
    typeof message.text !== "string" ||
    !object(part) ||
    part.type !== "resource" ||
    !object(part.resource)
  ) {
    throw new McpKnowledgeError("source_response_invalid");
  }
  // Exact success grammar excludes fuzzy path matches, symlink reads and fallback branches.
  const match = /^successfully downloaded (?:text|empty) file \(SHA: ([a-f0-9]{40})\)$/.exec(
    message.text
  );
  const resource = part.resource;
  if (
    !match?.[1] ||
    typeof resource.uri !== "string" ||
    typeof resource.text !== "string" ||
    typeof resource.mimeType !== "string" ||
    !/^text\/(?:plain|markdown)(?:;|$)/.test(resource.mimeType)
  ) {
    throw new McpKnowledgeError("source_response_invalid");
  }
  const prefix = `repo://${file.owner}/${file.repo}/sha/`;
  const suffix = `/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  if (
    !resource.uri.startsWith(prefix) ||
    !resource.uri.endsWith(suffix) ||
    !/^[a-f0-9]{40}$/.test(resource.uri.slice(prefix.length, -suffix.length))
  ) {
    throw new McpKnowledgeError("source_response_invalid");
  }
  if (Buffer.byteLength(resource.text, "utf8") > MCP_KNOWLEDGE_MAX_FILE_BYTES)
    throw new McpKnowledgeError("source_too_large");
  if (resource.text.includes("\0")) throw new McpKnowledgeError("source_response_invalid");
  return {
    text: resource.text,
    revision: match[1],
    sourceUrl: `https://github.com/${file.owner}/${file.repo}/blob/${file.ref
      .slice("refs/heads/".length)
      .split("/")
      .map(encodeURIComponent)
      .join("/")}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
  };
}
