import { OIM_CONNECTION_ID_ARGUMENT } from "@tulipfarm/integrations";
import { type OimManifest, oimPackageDigest, parseYamlDocument } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import {
  InMemoryToolCatalog,
  LiveToolGate,
  RegistryToolDispatcher,
  type RegistryToolDispatcherOptions,
} from "@tulipfarm/tool-host";
import {
  buildDeclarativeTools,
  type DeclarativeToolingDeps,
  declarativeToolName,
} from "../../tools/declarative/tools";
import type {
  IntegrationAuthoringToolContext,
  IntegrationDraftConnectionTestResult,
} from "./tools";

type IntegrationDraftConnectionTester = NonNullable<
  IntegrationAuthoringToolContext["connectionTester"]
>;
type IntegrationDraftConnectionTestInput = Parameters<IntegrationDraftConnectionTester["test"]>[0];

type InstalledReleaseTrust = {
  authorizeInstalledToolCompilation(input: {
    readonly businessId: string;
    readonly package: {
      readonly manifest: OimManifest;
      readonly files: ReadonlyMap<string, string>;
    };
  }): Promise<unknown>;
};

export interface IntegrationDraftConnectionTesterDeps
  extends Pick<
    RegistryToolDispatcherOptions,
    "artifacts" | "credentials" | "entitlements" | "guardrails" | "logger" | "soulLoader"
  > {
  readonly tooling: DeclarativeToolingDeps;
  readonly releaseTrust: InstalledReleaseTrust;
  readonly agents: NonNullable<RegistryToolDispatcherOptions["agents"]>;
  readonly authorityLayers: NonNullable<RegistryToolDispatcherOptions["authorityLayers"]>;
}

function refused(
  input: IntegrationDraftConnectionTestInput,
  error: string,
  operationId?: string,
  status?: string
): IntegrationDraftConnectionTestResult {
  return {
    connectionId: input.connectionId,
    passed: false,
    ...(operationId === undefined ? {} : { operationId }),
    ...(status === undefined ? {} : { status }),
    error,
  };
}

function reviewedIntegration(
  input: IntegrationDraftConnectionTestInput,
  operationId: string
): SoulIntegration {
  const operation = input.manifest.operations.find((entry) => entry.id === operationId);
  if (operation === undefined) throw new Error("health_check_operation_missing");

  const oimDocuments: Record<string, string> = {};
  const oimOpenApiDocuments: Record<string, unknown> = {};
  const oimPackageFiles: Record<string, string> = {};

  for (const file of input.manifest.files ?? []) {
    const reviewed = input.companions.get(file.path);
    if (reviewed === undefined) throw new Error("reviewed_companion_missing");
    oimPackageFiles[file.path] = reviewed;
    if (file.role === "graphql") oimDocuments[file.path] = reviewed;
    if (file.role === "openapi") {
      oimOpenApiDocuments[file.path] = parseYamlDocument(reviewed);
    }
  }

  return {
    slug: input.manifest.metadata.id,
    sourceIntegration: input.manifest.metadata.id,
    oimManifest: { ...input.manifest, operations: [operation] },
    ...(Object.keys(oimDocuments).length === 0 ? {} : { oimDocuments }),
    ...(Object.keys(oimOpenApiDocuments).length === 0 ? {} : { oimOpenApiDocuments }),
    ...(Object.keys(oimPackageFiles).length === 0 ? {} : { oimPackageFiles }),
  };
}

function safeDispatchResult(
  input: IntegrationDraftConnectionTestInput,
  operationId: string,
  result: Awaited<ReturnType<RegistryToolDispatcher["dispatch"]>>
): IntegrationDraftConnectionTestResult {
  switch (result.status) {
    case "succeeded": {
      const output =
        result.output !== null && typeof result.output === "object"
          ? (result.output as { readonly kind?: unknown })
          : undefined;
      if (
        output?.kind === "connection_denied" ||
        output?.kind === "connection_required" ||
        output?.kind === "connection_ambiguous" ||
        output?.kind === "connection_unhealthy" ||
        output?.kind === "credential_required"
      ) {
        return refused(
          input,
          "The caller or selected Connection is not authorized for this health check.",
          operationId,
          result.status
        );
      }
      return {
        connectionId: input.connectionId,
        passed: true,
        operationId,
        status: result.status,
      };
    }
    case "invalid_arguments":
      return refused(
        input,
        "The declared health check requires provider input and cannot run safely.",
        operationId,
        result.status
      );
    case "denied":
      return refused(
        input,
        "The caller or selected Connection is not authorized for this health check.",
        operationId,
        result.status
      );
    case "awaiting_approval":
      return refused(
        input,
        "The health check requires a separate approval.",
        operationId,
        result.status
      );
    case "needs_reconciliation":
      return refused(
        input,
        "The health check produced an indeterminate result.",
        operationId,
        result.status
      );
    case "awaiting_child":
    case "awaiting_retry":
      return refused(
        input,
        "The health check did not complete immediately.",
        operationId,
        result.status
      );
    case "failed":
      return refused(input, "The provider health check failed.", operationId, result.status);
  }
}

export function createIntegrationDraftConnectionTester(
  deps: IntegrationDraftConnectionTesterDeps
): IntegrationDraftConnectionTester {
  return {
    async test(input) {
      const { requestContext } = input;
      if (
        requestContext?.runId === undefined ||
        requestContext.toolCallId === undefined ||
        requestContext.subject === undefined ||
        requestContext.agentId === undefined
      ) {
        return refused(
          input,
          "A live Connection test requires the current Run, caller, and Agent."
        );
      }

      const healthCheckOperationId = input.manifest.auth?.healthCheckOperationId;
      if (healthCheckOperationId === undefined) {
        return refused(input, "The Integration does not declare a health-check operation.");
      }
      const healthCheck = input.manifest.operations.find(
        (operation) => operation.id === healthCheckOperationId
      );
      if (healthCheck === undefined) {
        return refused(input, "The declared health-check operation is missing.");
      }
      if (healthCheck.effect !== "read" && healthCheck.effect !== "sensitive_read") {
        return refused(
          input,
          "A health-check operation must be read-only.",
          healthCheckOperationId
        );
      }

      try {
        await deps.releaseTrust.authorizeInstalledToolCompilation({
          businessId: deps.tooling.businessId,
          package: { manifest: input.manifest, files: input.companions },
        });
      } catch {
        return refused(
          input,
          "This exact reviewed package is not installed and approved, so it cannot use an existing Connection.",
          healthCheckOperationId
        );
      }

      try {
        const integration = reviewedIntegration(input, healthCheckOperationId);
        const { tools, problems } = buildDeclarativeTools([integration], deps.tooling);
        const expectedName = declarativeToolName(input.manifest.metadata.id, healthCheck.name);
        const tool = tools.find((candidate) => candidate.name === expectedName);
        if (tool === undefined || problems.length > 0) {
          return refused(
            input,
            "The reviewed health-check operation could not be compiled.",
            healthCheckOperationId
          );
        }

        const agent = deps.agents.resolve(requestContext.agentId);
        if (agent === undefined) {
          return refused(
            input,
            "The current Agent could not be authorized.",
            healthCheckOperationId
          );
        }

        const catalog = new InMemoryToolCatalog();
        catalog.register(tool);
        const dispatcher = new RegistryToolDispatcher({
          registry: catalog,
          artifacts: deps.artifacts,
          gate: new LiveToolGate(),
          authorityLayers: deps.authorityLayers,
          ...(deps.soulLoader === undefined ? {} : { soulLoader: deps.soulLoader }),
          agents: deps.agents,
          ...(deps.credentials === undefined ? {} : { credentials: deps.credentials }),
          ...(deps.guardrails === undefined ? {} : { guardrails: deps.guardrails }),
          ...(deps.entitlements === undefined ? {} : { entitlements: deps.entitlements }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        });
        const result = await dispatcher.dispatch(
          {
            businessId: deps.tooling.businessId,
            runId: requestContext.runId,
            subject: requestContext.subject,
            source: "chat",
            bundleDigest: oimPackageDigest(input.manifest),
            agent,
          },
          {
            callId: `${requestContext.toolCallId}:connection-test`,
            name: tool.name,
            arguments: { [OIM_CONNECTION_ID_ARGUMENT]: input.connectionId },
          }
        );
        return safeDispatchResult(input, healthCheckOperationId, result);
      } catch {
        return refused(
          input,
          "The Connection health check could not be completed safely.",
          healthCheckOperationId
        );
      }
    },
  };
}
