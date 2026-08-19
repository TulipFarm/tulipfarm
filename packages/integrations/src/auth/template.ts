export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

export function renderDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderDeep(item, vars);
    return out;
  }
  return value;
}

export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function asIntegrationEnvValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export interface OAuthAuthorizeUrlConfig {
  readonly authorizationUrl: string;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly authorizeParams?: Readonly<Record<string, string>>;
}

export function buildOAuthAuthorizeUrl(
  config: OAuthAuthorizeUrlConfig,
  input: { clientId: string; state: string; codeChallenge?: string; redirectUri: string }
): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  if (config.scopes && config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(config.scopeSeparator ?? " "));
  }
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(config.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
