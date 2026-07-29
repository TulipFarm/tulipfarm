import { ArtifactStore } from "@tulipfarm/storage";
import {
  type SurfaceArtifact,
  type SurfaceComponentDefinition,
  type SurfaceRendererManifest,
  surfaceArtifactHash,
  updateSurfaceArtifact,
} from "@tulipfarm/surface";
import type { Queryable } from "../db";
import { transactionPort } from "../db";

export interface SurfaceArtifactStore {
  create(
    artifact: SurfaceArtifact,
    producer?: { runId?: string; stateKey?: string }
  ): Promise<void>;
  get(artifactId: string, revision?: number): Promise<SurfaceArtifact | null>;
  update(
    artifactId: string,
    expectedRevision: number,
    props: Readonly<Record<string, unknown>>,
    catalog?: readonly SurfaceComponentDefinition[],
    rendererManifest?: SurfaceRendererManifest
  ): Promise<SurfaceArtifact>;
}

function storageId(artifactId: string, revision: number): string {
  return `surface:${artifactId}:${revision}`;
}

export class PgSurfaceArtifactStore implements SurfaceArtifactStore {
  private readonly artifacts: ArtifactStore;

  constructor(private readonly q: Queryable) {
    this.artifacts = new ArtifactStore(transactionPort(q));
  }

  async create(
    artifact: SurfaceArtifact,
    producer: { runId?: string; stateKey?: string } = {}
  ): Promise<void> {
    await this.artifacts.put({
      id: storageId(artifact.id, artifact.revision),
      businessId: "default",
      schemaRef: `tsp://${artifact.protocolVersion}/surface-artifact`,
      content: artifact as Record<string, unknown>,
      blob: null,
      contentHash: surfaceArtifactHash(artifact),
      classification: [artifact.classification],
      acl: { readers: artifact.audience },
      retention: { policy: "standard", expiresAt: null },
      redaction: { redactedPaths: [] },
      producer: {
        runId: producer.runId ?? "conversation",
        stateKey: producer.stateKey ?? artifact.id,
        attempt: artifact.revision,
      },
      createdAt: new Date().toISOString(),
    });
  }

  async get(artifactId: string, revision?: number): Promise<SurfaceArtifact | null> {
    if (revision !== undefined) {
      const found = await this.artifacts.find("default", storageId(artifactId, revision));
      return found?.content as SurfaceArtifact | null;
    }
    const { rows } = await this.q.query(
      `SELECT content
         FROM artifacts
        WHERE business_id = 'default'
          AND schema_ref = 'tsp://1.0/surface-artifact'
          AND content->>'id' = $1
        ORDER BY (content->>'revision')::integer DESC
        LIMIT 1`,
      [artifactId]
    );
    return (rows[0]?.content as SurfaceArtifact | undefined) ?? null;
  }

  async update(
    artifactId: string,
    expectedRevision: number,
    props: Readonly<Record<string, unknown>>,
    catalog: readonly SurfaceComponentDefinition[] = [],
    rendererManifest?: SurfaceRendererManifest
  ): Promise<SurfaceArtifact> {
    const previous = await this.get(artifactId);
    if (!previous) throw new Error(`Surface Artifact "${artifactId}" was not found.`);
    const next = updateSurfaceArtifact(
      previous,
      expectedRevision,
      props,
      catalog,
      rendererManifest
    );
    await this.create(next);
    return next;
  }
}

export class MemorySurfaceArtifactStore implements SurfaceArtifactStore {
  private readonly artifacts = new Map<string, SurfaceArtifact[]>();

  async create(artifact: SurfaceArtifact): Promise<void> {
    const revisions = this.artifacts.get(artifact.id) ?? [];
    const existing = revisions.find((entry) => entry.revision === artifact.revision);
    if (existing && surfaceArtifactHash(existing) !== surfaceArtifactHash(artifact)) {
      throw new Error(`Surface Artifact revision conflict for ${artifact.id}.`);
    }
    if (!existing) {
      revisions.push(structuredClone(artifact));
      revisions.sort((left, right) => left.revision - right.revision);
      this.artifacts.set(artifact.id, revisions);
    }
  }

  async get(artifactId: string, revision?: number): Promise<SurfaceArtifact | null> {
    const revisions = this.artifacts.get(artifactId) ?? [];
    const found =
      revision === undefined
        ? revisions[revisions.length - 1]
        : revisions.find((entry) => entry.revision === revision);
    return found ? structuredClone(found) : null;
  }

  async update(
    artifactId: string,
    expectedRevision: number,
    props: Readonly<Record<string, unknown>>,
    catalog: readonly SurfaceComponentDefinition[] = [],
    rendererManifest?: SurfaceRendererManifest
  ): Promise<SurfaceArtifact> {
    const previous = await this.get(artifactId);
    if (!previous) throw new Error(`Surface Artifact "${artifactId}" was not found.`);
    const next = updateSurfaceArtifact(
      previous,
      expectedRevision,
      props,
      catalog,
      rendererManifest
    );
    await this.create(next);
    return next;
  }
}
