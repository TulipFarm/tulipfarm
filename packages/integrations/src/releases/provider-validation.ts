import type { OimManifest, OimOperation, OimPackageContent } from "@tulipfarm/schema";
import { parse as parseYaml } from "yaml";
import { compileOimGraphqlOperations } from "../egress/oim-graphql-compile";
import { compileOimHttpOperations } from "../egress/oim-http-compile";
import { compileOimOpenApiOperations } from "../egress/oim-openapi-compile";

function companionText(content: OimPackageContent): string {
  return typeof content === "string"
    ? content
    : new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function providerError(operation: OimOperation, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `operations: ${operation.id} cannot compile ${operation.source.type} provider contract (${detail})`;
}

function manifestForOperation(manifest: OimManifest, operation: OimOperation): OimManifest {
  return { ...manifest, operations: [operation] };
}

/**
 * Compiles each already-validated operation against its local provider documents.
 *
 * This catches compiler-only contradictions before an installed package is allowed to publish
 * Tools. Configuration is deferred because its values belong to a Connection, not the package.
 */
export function oimProviderContractIssues(
  manifest: OimManifest,
  files: ReadonlyMap<string, OimPackageContent>
): string[] {
  const issues: string[] = [];

  for (const operation of manifest.operations) {
    const scopedManifest = manifestForOperation(manifest, operation);
    try {
      if (operation.source.type === "http") {
        compileOimHttpOperations(scopedManifest, {}, { deferConfiguration: true });
      } else if (operation.source.type === "graphql") {
        const content = files.get(operation.source.documentFile);
        if (content === undefined) continue;
        compileOimGraphqlOperations(
          scopedManifest,
          new Map([[operation.source.documentFile, companionText(content)]]),
          {},
          { deferConfiguration: true }
        );
      } else if (operation.source.type === "openapi") {
        const content = files.get(operation.source.file);
        if (content === undefined) continue;
        compileOimOpenApiOperations(
          scopedManifest,
          new Map([[operation.source.file, parseYaml(companionText(content))]]),
          {},
          { deferConfiguration: true }
        );
      }
    } catch (error) {
      issues.push(providerError(operation, error));
    }
  }

  return issues;
}
