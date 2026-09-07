import { MAX_FILE_BYTES } from "@tulipfarm/files";
import type {
  SlackExternalUploadPort,
  SlackFileUploadSource,
  SlackFileUploadStatePort,
  SlackIntegrationIdentityPort,
  SlackOwnedObjectPort,
} from "@tulipfarm/integrations";
import type { ProviderFileUploadStore, ProviderObjectOwnershipStore } from "@tulipfarm/storage";

interface SlackIntegrationDirectory {
  loadProviderSnapshot(
    businessId: string,
    provider: string
  ): Promise<{ integrations: readonly { id: string; status: string }[] }>;
}

interface SlackRunIdentityReader {
  find(
    businessId: string,
    runId: string
  ): Promise<{ identity: { effectiveSubject: { kind: string; id: string } } } | null>;
}

interface SlackFileContentReader {
  content(
    businessId: string,
    fileId: string,
    principalId: string
  ): Promise<{
    file: { filename: string; mediaType: string; sizeBytes: number };
    body: AsyncIterable<Uint8Array>;
  }>;
}

export class SlackIntegrationIdentityResolver implements SlackIntegrationIdentityPort {
  constructor(private readonly integrations: SlackIntegrationDirectory) {}

  async resolve(businessId: string): Promise<string | undefined> {
    const snapshot = await this.integrations.loadProviderSnapshot(businessId, "slack");
    const active = snapshot.integrations.filter((integration) => integration.status === "active");
    return active.length === 1 ? active[0]?.id : undefined;
  }
}

export class SlackProviderObjectOwnership implements SlackOwnedObjectPort {
  constructor(private readonly store: ProviderObjectOwnershipStore) {}

  owns(input: Parameters<SlackOwnedObjectPort["owns"]>[0]): Promise<boolean> {
    return this.store.owns({ ...input, provider: "slack" });
  }

  record(input: Parameters<SlackOwnedObjectPort["record"]>[0]): Promise<void> {
    return this.store.record({ ...input, provider: "slack" });
  }

  remove(input: Parameters<SlackOwnedObjectPort["remove"]>[0]): Promise<void> {
    return this.store.remove({ ...input, provider: "slack" });
  }

  findByCreationIntent(
    input: Parameters<SlackOwnedObjectPort["findByCreationIntent"]>[0]
  ): ReturnType<SlackOwnedObjectPort["findByCreationIntent"]> {
    return this.store.findByCreationIntent({ ...input, provider: "slack" });
  }
}

export class SlackProviderFileUploads implements SlackFileUploadStatePort {
  constructor(private readonly store: ProviderFileUploadStore) {}

  find(input: Parameters<SlackFileUploadStatePort["find"]>[0]) {
    return this.store.find({ ...input, provider: "slack" });
  }

  urlRequested(input: Parameters<SlackFileUploadStatePort["urlRequested"]>[0]): Promise<void> {
    return this.store.urlRequested({ ...input, provider: "slack" });
  }

  advance(input: Parameters<SlackFileUploadStatePort["advance"]>[0]): Promise<void> {
    return this.store.advance({ ...input, provider: "slack" });
  }
}

export class GovernedSlackFileUploadSource implements SlackFileUploadSource {
  constructor(
    private readonly runs: SlackRunIdentityReader,
    private readonly files: SlackFileContentReader
  ) {}

  async load(input: { businessId: string; runId: string; fileId: string }) {
    const run = await this.runs.find(input.businessId, input.runId);
    if (run === null || run.identity.effectiveSubject.kind !== "user") {
      throw new Error("slack_file_upload_subject_unavailable");
    }
    const { file, body } = await this.files.content(
      input.businessId,
      input.fileId,
      run.identity.effectiveSubject.id
    );
    if (file.sizeBytes > MAX_FILE_BYTES) throw new Error("slack_file_upload_too_large");
    const bytes = new Uint8Array(file.sizeBytes);
    let offset = 0;
    for await (const chunk of body) {
      if (offset + chunk.byteLength > bytes.byteLength) {
        throw new Error("slack_file_upload_size_mismatch");
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== bytes.byteLength) throw new Error("slack_file_upload_size_mismatch");
    return { filename: file.filename, mediaType: file.mediaType, bytes };
  }
}

export class SlackExternalUploadHttp implements SlackExternalUploadPort {
  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  async upload(url: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "files.slack.com") {
      throw new Error("slack_upload_url_rejected");
    }
    const response = await this.fetchImpl(target, {
      method: "POST",
      headers: { "content-type": mediaType },
      body: bytes,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`slack_upload_failed:${response.status}`);
  }
}
