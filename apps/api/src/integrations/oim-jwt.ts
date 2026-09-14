import {
  type EgressHttpPort,
  exchangeGitHubAppJwt,
  exchangeOAuthJwtBearer,
  type OimJwtAssertionRefreshRequest,
  type OimOAuthRefresh,
  signRs256Assertion,
} from "@tulipfarm/integrations";

function targetValue(
  request: OimJwtAssertionRefreshRequest,
  target:
    | { readonly type: "credential"; readonly slot: string }
    | {
        readonly type: "configuration";
        readonly field: string;
      }
): string {
  const value =
    target.type === "credential"
      ? request.credentials[target.slot]
      : request.connection.configuration[target.field];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("jwt_assertion_value_missing");
  return value;
}

export async function refreshOimJwtAssertionStep(
  request: OimJwtAssertionRefreshRequest,
  options: { readonly http: EgressHttpPort; readonly now?: Date }
): Promise<OimOAuthRefresh> {
  const now = options.now ?? new Date();
  const issuer = targetValue(request, request.step.issuer);
  const privateKey = targetValue(request, request.step.privateKey);
  const subject =
    request.step.subject === undefined ? undefined : targetValue(request, request.step.subject);
  const assertion = signRs256Assertion(
    {
      issuer,
      ...(subject === undefined ? {} : { subject }),
      ...(request.step.exchange === "oauth_jwt_bearer"
        ? {
            audience: request.step.audience ?? request.step.tokenUrl,
            ...(request.step.scopes === undefined ? {} : { scopes: request.step.scopes }),
          }
        : {}),
    },
    privateKey,
    { now, ttlSeconds: request.step.ttlSeconds }
  );

  const exchanged =
    request.step.exchange === "oauth_jwt_bearer"
      ? await exchangeOAuthJwtBearer(options.http, request.step.tokenUrl, assertion, now)
      : await exchangeGitHubApp(request, options.http, assertion);

  const credentialValues: Record<string, string> = {};
  for (const binding of request.step.bindings) {
    if (binding.target.type !== "credential") continue;
    const value = readPointer(exchanged.credentialValues, binding.sourcePath);
    if (typeof value === "string") credentialValues[binding.target.slot] = value;
  }
  if (Object.keys(credentialValues).length === 0) {
    throw new Error("jwt_assertion_binding_missing");
  }
  return { credentialValues, expiresAt: exchanged.expiresAt };
}

async function exchangeGitHubApp(
  request: OimJwtAssertionRefreshRequest,
  http: EgressHttpPort,
  assertion: string
) {
  if (request.step.installationId === undefined) {
    throw new Error("jwt_assertion_installation_id_missing");
  }
  return exchangeGitHubAppJwt(
    http,
    request.step.tokenUrl.replace(
      "{installationId}",
      encodeURIComponent(targetValue(request, request.step.installationId))
    ),
    assertion
  );
}

function readPointer(source: unknown, pointer: string): unknown {
  let current = source;
  for (const segment of pointer.slice(1).split("/")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return current;
}
