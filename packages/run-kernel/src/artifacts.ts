import { createHash } from "node:crypto";
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

export interface ArtifactStorePort {
  put(input: PutArtifactInput): Promise<PutArtifactResult>;
  find(businessId: string, artifactId: string): Promise<PersistedArtifact | null>;
  appendLineage(input: AppendArtifactLineageInput): Promise<void>;
}

export type ArtifactStorageMode = "inline" | "blob";

export const FILE_ARTIFACT_SCHEMA_REF = "tulipfarm.artifact/file/v1";

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
  readonly derivedFrom?: readonly string[];
}

export interface PublishedArtifact {
  readonly outcome: PutArtifactResult["outcome"];
  readonly id: string;
  readonly contentHash: string;
  readonly blob: BlobRef | null;
}

export interface PublishFileArtifactInput {
  readonly id: string;
  readonly businessId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName: string;
  readonly classification: readonly string[];
  readonly acl: ArtifactAcl;
  readonly retention: ArtifactRetention;
  readonly redaction: ArtifactRedaction;
  readonly producer: ArtifactProducer;
  readonly createdAt: string;
  readonly derivedFrom?: readonly string[];
}

export interface PublishedFileArtifact {
  readonly outcome: PutArtifactResult["outcome"];
  readonly id: string;
  readonly contentHash: string;
  readonly blob: BlobRef;
  readonly mediaType: string;
  readonly fileName: string;
  readonly bytes: number;
}

export interface FileArtifactContent {
  readonly mediaType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
}

export interface ArtifactReadRequest {
  readonly businessId: string;
  readonly artifactId: string;
  readonly reader: string;
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
 * Artifacts are hash-checked, schema-checked, authorization-checked, and stored once with
 * classification, ACL, retention, and redaction metadata.
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

  async publishFile(input: PublishFileArtifactInput): Promise<PublishedFileArtifact> {
    if (!this.blobs) throw new ArtifactAccessError("artifact_blob_unavailable", input.id);
    if (
      input.mediaType.length === 0 ||
      input.mediaType.length > 256 ||
      input.fileName.length === 0 ||
      input.fileName.length > 512 ||
      input.fileName.includes("/") ||
      input.fileName.includes("\\") ||
      input.redaction.redactedPaths.length > 0
    ) {
      throw new ArtifactAccessError("artifact_schema_invalid", input.id);
    }

    const blob = await this.blobs.put(input.bytes, input.mediaType);
    const rawHash = createHash("sha256").update(input.bytes).digest("hex");
    if (blob.hash !== rawHash) {
      throw new ArtifactAccessError("artifact_tampered", input.id);
    }
    const content = {
      blob: { key: blob.key, hash: blob.hash },
      mediaType: input.mediaType,
      fileName: input.fileName,
      bytes: input.bytes.byteLength,
    };
    const result = await this.store.put({
      id: input.id,
      businessId: input.businessId,
      schemaRef: FILE_ARTIFACT_SCHEMA_REF,
      content,
      blob: null,
      contentHash: rawHash,
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
      contentHash: rawHash,
      blob,
      mediaType: input.mediaType,
      fileName: input.fileName,
      bytes: input.bytes.byteLength,
    };
  }

  async openFile(request: ArtifactReadRequest): Promise<FileArtifactContent> {
    const artifact = await this.store.find(request.businessId, request.artifactId);
    if (!artifact) throw new ArtifactAccessError("artifact_not_found", request.artifactId);
    this.authorize(artifact, request);
    if (
      artifact.schemaRef !== FILE_ARTIFACT_SCHEMA_REF ||
      artifact.contentKind !== "inline" ||
      !isJsonObject(artifact.content)
    ) {
      throw new ArtifactAccessError("artifact_schema_invalid", artifact.id);
    }
    const manifest = artifact.content;
    const blob = isJsonObject(manifest.blob) ? manifest.blob : undefined;
    if (
      !this.blobs ||
      blob === undefined ||
      typeof blob.key !== "string" ||
      typeof blob.hash !== "string" ||
      typeof manifest.mediaType !== "string" ||
      typeof manifest.fileName !== "string" ||
      typeof manifest.bytes !== "number"
    ) {
      throw new ArtifactAccessError("artifact_tampered", artifact.id);
    }
    const bytes = await this.blobs.get({ key: blob.key, hash: blob.hash });
    const rawHash = createHash("sha256").update(bytes).digest("hex");
    if (
      rawHash !== blob.hash ||
      rawHash !== artifact.contentHash ||
      bytes.byteLength !== manifest.bytes
    ) {
      throw new ArtifactAccessError("artifact_tampered", artifact.id);
    }
    return {
      mediaType: manifest.mediaType,
      fileName: manifest.fileName,
      bytes,
      contentHash: rawHash,
    };
  }

  async read(request: ArtifactReadRequest): Promise<ArtifactContent> {
    const artifact = await this.store.find(request.businessId, request.artifactId);
    if (!artifact) throw new ArtifactAccessError("artifact_not_found", request.artifactId);
    this.authorize(artifact, request);
    return this.materialize(artifact);
  }

  async open(artifact: PersistedArtifact, request: ArtifactReadRequest): Promise<ArtifactContent> {
    this.authorize(artifact, request);
    return this.materialize(artifact);
  }

  private authorize(artifact: PersistedArtifact, request: ArtifactReadRequest): void {
    if (artifact.businessId !== request.businessId || artifact.id !== request.artifactId) {
      throw new ArtifactAccessError("artifact_not_found", request.artifactId);
    }
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
