import { canonicalize } from "@tulipfarm/schema";
import type {
  AppendArtifactLineageInput,
  ArtifactAcl,
  ArtifactProducer,
  ArtifactRedaction,
  ArtifactRetention,
  BlobPort,
  BlobRef,
  PersistedArtifact,
  PutArtifactInput,
  PutArtifactResult,
} from "@tulipfarm/storage";
import { type JsonObject, TypedOutputError, type TypedOutputValidator } from "./outputs";

/** Narrow surface `ArtifactService` needs; `@tulipfarm/storage`'s `ArtifactStore` satisfies it. */
export interface ArtifactStorePort {
  put(input: PutArtifactInput): Promise<PutArtifactResult>;
  find(businessId: string, artifactId: string): Promise<PersistedArtifact | null>;
  appendLineage(input: AppendArtifactLineageInput): Promise<void>;
}

export type ArtifactStorageMode = "inline" | "blob";

export interface PublishArtifactInput {
  readonly id: string;
  readonly businessId: string;
  readonly schemaRef: string;
  readonly value: unknown;
  readonly storage: ArtifactStorageMode;
  readonly classification: readonly string[];
  readonly acl: ArtifactAcl;
  readonly retention: ArtifactRetention;
  readonly redaction: ArtifactRedaction;
  readonly producer: ArtifactProducer;
  readonly createdAt: string;
  /** Artifacts this output was derived from; recorded as `derived_from` lineage edges. */
  readonly derivedFrom?: readonly string[];
}

export interface PublishedArtifact {
  readonly outcome: PutArtifactResult["outcome"];
  readonly id: string;
  readonly contentHash: string;
  readonly blob: BlobRef | null;
}

export interface ArtifactReadRequest {
  readonly businessId: string;
  readonly artifactId: string;
  /** Principal ref (`kind:id`) the read is performed for. */
  readonly reader: string;
  /** Classifications the downstream Context may carry; the Artifact must stay within them. */
  readonly allowedClassifications: readonly string[];
  readonly now: Date;
}

export interface ArtifactContent {
  readonly schemaRef: string;
  readonly content: JsonObject;
  readonly contentHash: string;
}

export type ArtifactAccessErrorCode =
  | "artifact_blob_unavailable"
  | "artifact_classification_denied"
  | "artifact_expired"
  | "artifact_not_found"
  | "artifact_redaction_violation"
  | "artifact_schema_invalid"
  | "artifact_tampered"
  | "artifact_unauthorized";

/** Denial or integrity failure. The message names the Artifact, never its content. */
export class ArtifactAccessError extends Error {
  readonly name = "ArtifactAccessError";

  constructor(
    readonly code: ArtifactAccessErrorCode,
    readonly artifactId: string
  ) {
    super(`${code}:${artifactId}`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a JSON pointer (`/a/b`) still resolves inside the content. */
function hasPointer(content: JsonObject, pointer: string): boolean {
  const segments = pointer.split("/").slice(1);
  let cursor: unknown = content;
  for (const segment of segments) {
    if (!isJsonObject(cursor)) return false;
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(cursor, key)) return false;
    cursor = cursor[key];
  }
  return segments.length > 0;
}

/**
 * Immutable typed outputs and Artifacts (SPEC §7.2). Publishing AJV-validates the output, hashes
 * it canonically, and stores it once with its classification, ACL, retention, and redaction
 * metadata. Reading re-checks authorization, classification, retention, content hash, and schema,
 * so unauthorized, tampered, or schema-invalid output never reaches a downstream Context.
 */
export class ArtifactService {
  constructor(
    private readonly store: ArtifactStorePort,
    private readonly validator: TypedOutputValidator,
    private readonly blobs?: BlobPort
  ) {}

  async publish(input: PublishArtifactInput): Promise<PublishedArtifact> {
    const validated = this.validator.validate(input.schemaRef, input.value);
    for (const pointer of input.redaction.redactedPaths) {
      if (hasPointer(validated.content, pointer)) {
        throw new ArtifactAccessError("artifact_redaction_violation", input.id);
      }
    }

    let blob: BlobRef | null = null;
    if (input.storage === "blob") {
      if (!this.blobs) throw new ArtifactAccessError("artifact_blob_unavailable", input.id);
      blob = await this.blobs.put(
        new TextEncoder().encode(canonicalize(validated.content)),
        "application/json"
      );
    }

    const result = await this.store.put({
      id: input.id,
      businessId: input.businessId,
      schemaRef: validated.schemaRef,
      content: blob === null ? validated.content : null,
      blob,
      contentHash: validated.contentHash,
      classification: input.classification,
      acl: input.acl,
      retention: input.retention,
      redaction: input.redaction,
      producer: input.producer,
      createdAt: input.createdAt,
    });

    for (const sourceArtifactId of input.derivedFrom ?? []) {
      await this.store.appendLineage({
        businessId: input.businessId,
        artifactId: input.id,
        sourceArtifactId,
        relation: "derived_from",
        createdAt: input.createdAt,
      });
    }

    return {
      outcome: result.outcome,
      id: input.id,
      contentHash: validated.contentHash,
      blob,
    };
  }

  async read(request: ArtifactReadRequest): Promise<ArtifactContent> {
    const artifact = await this.store.find(request.businessId, request.artifactId);
    if (!artifact) throw new ArtifactAccessError("artifact_not_found", request.artifactId);
    this.authorize(artifact, request);
    return this.materialize(artifact);
  }

  /** Applies the same denials to an Artifact already resolved through a named output mapping. */
  async open(artifact: PersistedArtifact, request: ArtifactReadRequest): Promise<ArtifactContent> {
    this.authorize(artifact, request);
    return this.materialize(artifact);
  }

  private authorize(artifact: PersistedArtifact, request: ArtifactReadRequest): void {
    const { expiresAt } = artifact.retention;
    if (expiresAt !== null && new Date(expiresAt).getTime() <= request.now.getTime()) {
      throw new ArtifactAccessError("artifact_expired", artifact.id);
    }
    if (!artifact.acl.readers.includes(request.reader)) {
      throw new ArtifactAccessError("artifact_unauthorized", artifact.id);
    }
    const allowed = new Set(request.allowedClassifications);
    if (!artifact.classification.every((label) => allowed.has(label))) {
      throw new ArtifactAccessError("artifact_classification_denied", artifact.id);
    }
  }

  private async materialize(artifact: PersistedArtifact): Promise<ArtifactContent> {
    const content = await this.load(artifact);
    let validated: ArtifactContent;
    try {
      validated = this.validator.validate(artifact.schemaRef, content);
    } catch (error) {
      if (error instanceof TypedOutputError) {
        throw new ArtifactAccessError("artifact_schema_invalid", artifact.id);
      }
      throw error;
    }
    if (validated.contentHash !== artifact.contentHash) {
      throw new ArtifactAccessError("artifact_tampered", artifact.id);
    }
    return validated;
  }

  private async load(artifact: PersistedArtifact): Promise<JsonObject> {
    if (artifact.contentKind === "inline") {
      if (!isJsonObject(artifact.content)) {
        throw new ArtifactAccessError("artifact_tampered", artifact.id);
      }
      return artifact.content;
    }
    if (!this.blobs || !artifact.blob) {
      throw new ArtifactAccessError("artifact_blob_unavailable", artifact.id);
    }
    const bytes = await this.blobs.get(artifact.blob);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ArtifactAccessError("artifact_tampered", artifact.id);
    }
    if (!isJsonObject(parsed)) throw new ArtifactAccessError("artifact_tampered", artifact.id);
    return parsed;
  }
}
