import type { OimReleaseSourceInspection } from "@tulipfarm/integrations";
import { oimPackageDigest, oimPackageIssues } from "@tulipfarm/schema";
import type { OimReleaseCandidateReview, OimReleaseInspectionResult } from "./control-plane";

type Candidate = OimReleaseSourceInspection["candidates"][number];
type OperationSource = Candidate["package"]["manifest"]["operations"][number]["source"];

function operationDestination(source: OperationSource): string {
  switch (source.type) {
    case "http":
      return source.baseUrl;
    case "graphql":
      return source.url;
    case "openapi":
      return source.baseUrl ?? `OpenAPI document: ${source.file}`;
  }
}

function candidateReview(candidate: Candidate): OimReleaseCandidateReview {
  const manifest = candidate.package.manifest;
  return {
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    auth: {
      credentialLabels: manifest.auth?.credentialSlots.map((slot) => slot.label) ?? [],
      configurationLabels: manifest.auth?.configurationFields?.map((field) => field.label) ?? [],
      steps:
        manifest.auth?.steps.map((step) => ({
          title: step.title,
          type: step.type,
        })) ?? [],
    },
    operations: manifest.operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      effect: operation.effect,
      destination: operationDestination(operation.source),
    })),
    ingress: {
      events: manifest.events !== undefined,
      polling: manifest.ingress?.kind === "polling",
      knowledge: manifest.knowledge !== undefined,
    },
  };
}

export function projectOimReleaseSourceInspection(
  source: string,
  inspection: OimReleaseSourceInspection
): OimReleaseInspectionResult {
  return {
    source,
    ref: inspection.ref,
    candidates: inspection.candidates.map((candidate) => ({
      sourcePath: candidate.sourcePath,
      integrationId: candidate.package.manifest.metadata.id,
      version: candidate.package.manifest.metadata.version,
      packageDigest: oimPackageDigest(candidate.package.manifest),
      issues: [
        ...(candidate.sourceIssues ?? []),
        ...oimPackageIssues(candidate.package.manifest, candidate.package.files),
      ],
      review: candidateReview(candidate),
    })),
  };
}
