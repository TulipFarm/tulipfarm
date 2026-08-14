import type {
  BindOutputInput,
  BindOutputResult,
  PersistedArtifact,
  StateOutputBinding,
} from "@tulipfarm/storage";
import { ArtifactAccessError, type ArtifactService } from "./artifacts";
import type { JsonObject } from "./outputs";

export interface OutputBindingStore {
  bindOutput(input: BindOutputInput): Promise<BindOutputResult>;
  resolveOutput(
    businessId: string,
    runId: string,
    stateKey: string,
    outputName: string
  ): Promise<PersistedArtifact | null>;
  listOutputs(businessId: string, runId: string): Promise<readonly StateOutputBinding[]>;
}

export interface ContextInputMapping {
  readonly name: string;
  readonly from: { readonly stateKey: string; readonly outputName: string };
}

export interface ContextAssemblyRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly reader: string;
  readonly allowedClassifications: readonly string[];
  readonly now: Date;
  readonly inputs: readonly ContextInputMapping[];
}

/** Context assembly fails on missing, unauthorized, tampered, or schema-invalid outputs. */
export class RunOutputLineage {
  constructor(
    private readonly store: OutputBindingStore,
    private readonly artifacts: ArtifactService
  ) {}

  /** Binds a produced Artifact to a State output name. Rebinding a different Artifact fails. */
  async bind(input: BindOutputInput): Promise<BindOutputResult> {
    return this.store.bindOutput(input);
  }

  async assembleContext(request: ContextAssemblyRequest): Promise<Record<string, JsonObject>> {
    const assembled: Record<string, JsonObject> = {};
    for (const input of request.inputs) {
      const artifact = await this.store.resolveOutput(
        request.businessId,
        request.runId,
        input.from.stateKey,
        input.from.outputName
      );
      if (!artifact) {
        throw new ArtifactAccessError(
          "artifact_not_found",
          `${input.from.stateKey}/${input.from.outputName}`
        );
      }
      const opened = await this.artifacts.open(artifact, {
        businessId: request.businessId,
        artifactId: artifact.id,
        reader: request.reader,
        allowedClassifications: request.allowedClassifications,
        now: request.now,
      });
      assembled[input.name] = opened.content;
    }
    return assembled;
  }

  /** Lists the named outputs a Run produced, in deterministic order. */
  async trace(businessId: string, runId: string): Promise<readonly StateOutputBinding[]> {
    return this.store.listOutputs(businessId, runId);
  }
}
