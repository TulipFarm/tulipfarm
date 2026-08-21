import { resolveAuthSteps } from "./integration-auth";
import type { AuthStep, IntegrationManifest } from "./types";

/* Third-party integration manifests are data only; bundled integrations are reviewed code. */

/** Manifest constructs that execute third-party code in one of our processes. */
function codeExecutionIssues(manifest: IntegrationManifest): string[] {
  const issues: string[] = [];
  const egress = manifest.egress;

  if (egress?.type === "ts-code") {
    issues.push(
      'egress.type "ts-code" runs a handler module in the host process; third-party integrations must be declarative (use "openapi", "mcp" over sse, or "none")'
    );
  }

  // A stdio MCP server is `command` + `args` spawned locally — a remote-controlled process on the
  // host. `sse` is a URL, which is data.
  if (egress?.type === "mcp" && egress.entry?.transport === "stdio") {
    issues.push(
      'egress.entry.transport "stdio" spawns a local process; third-party integrations must use the "sse" transport'
    );
  }

  // The ingress classifier is a JS module. It runs sandboxed with no I/O, but "sandboxed" is a
  // smaller promise than "absent", and V1 draws the line at absent.
  if (manifest.ingress?.handler) {
    issues.push(
      "ingress.handler is a code module; third-party integrations cannot declare ingress in this version"
    );
  }

  return issues;
}

/** Provider URLs receive credentials/codes/tokens, so every such URL is validated. */
function authUrls(step: AuthStep): { label: string; url: string }[] {
  switch (step.kind) {
    case "app_manifest":
      return [
        { label: "auth.app_manifest.create_url", url: step.create_url },
        ...(step.create_url_for_org
          ? [{ label: "auth.app_manifest.create_url_for_org", url: step.create_url_for_org }]
          : []),
        ...(step.exchange
          ? [{ label: "auth.app_manifest.exchange.url", url: step.exchange.url }]
          : []),
      ];
    case "oauth2":
      return [
        ...(step.authorization_url
          ? [{ label: "auth.oauth2.authorization_url", url: step.authorization_url }]
          : []),
        { label: "auth.oauth2.token_url", url: step.token_url },
        ...(step.refresh_url ? [{ label: "auth.oauth2.refresh_url", url: step.refresh_url }] : []),
      ];
    case "install":
      return [{ label: "auth.install.url", url: step.url }];
    case "fields":
      return [];
    case "webhook":
      return [{ label: "auth.webhook.url", url: step.url }];
  }
}

/** Require literal https scheme and host; placeholders may not choose the destination. */
function urlIssue(url: string): string | undefined {
  if (!url.startsWith("https://")) return "must be an https:// URL";

  let parsed: URL;
  try {
    // Placeholders are legal in a path or query, so only the authority is parsed here.
    parsed = new URL(`${url.split(/[/?#]/, 3).slice(0, 3).join("/")}/`);
  } catch {
    // An unparseable authority is reported as an invalid URL.
    return "is not a valid URL";
  }
  if (!parsed.hostname) return "is not a valid URL";
  if (/[{}]/.test(parsed.host)) return "must name its host literally, not through a placeholder";
  return undefined;
}

function transportIssues(manifest: IntegrationManifest): string[] {
  const issues: string[] = [];

  for (const step of resolveAuthSteps(manifest)) {
    for (const { label, url } of authUrls(step)) {
      const issue = urlIssue(url);
      if (issue) issues.push(`${label} ${issue} (got "${url}")`);
    }
  }

  if (manifest.egress?.type === "mcp" && manifest.egress.entry?.transport === "sse") {
    const issue = urlIssue(manifest.egress.entry.url);
    if (issue) issues.push(`egress.entry.url ${issue} (got "${manifest.egress.entry.url}")`);
  }

  // Where the connection credential actually gets sent. The referenced spec's own `servers` entry
  // is checked at compile time (`compileOpenApiEgress`) because it lives in a file this validator
  // never reads — but when the manifest overrides it, the override is reviewable here.
  if (manifest.egress?.type === "openapi" && manifest.egress.base_url !== undefined) {
    const issue = urlIssue(manifest.egress.base_url);
    if (issue) issues.push(`egress.base_url ${issue} (got "${manifest.egress.base_url}")`);
  }

  return issues;
}

/** Simple Icons slugs are allowlisted to prevent path traversal through icon lookup. */
const ICON_SLUG_RE = /^[a-z0-9_]{1,32}$/;

function iconIssues(manifest: IntegrationManifest): string[] {
  const icon = manifest.icon;
  if (icon === undefined || ICON_SLUG_RE.test(icon)) return [];
  return [
    `icon must be a Simple Icons slug — lowercase letters, digits, and underscores only (got "${icon}")`,
  ];
}

/** Fatal install gate for untrusted manifests; partial installs would become trusted on next boot. */
export function validateThirdPartyManifest(manifest: IntegrationManifest): string[] {
  return [...codeExecutionIssues(manifest), ...transportIssues(manifest), ...iconIssues(manifest)];
}
