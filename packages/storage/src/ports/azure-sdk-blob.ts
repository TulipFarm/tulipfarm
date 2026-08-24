import {
  BlobServiceClient,
  type ContainerClient,
  RestError,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  type AzureBlobApi,
  AzureBlobNotFoundError,
  type AzureGetRequest,
  type AzureObjectHead,
  type AzurePutRequest,
} from "./azure-blob-api";

/**
 * Everything an operator configures to point this deployment at an Azure Blob Storage container.
 *
 * Two credential shapes, because those are the two operators actually use: a full connection
 * string, or an account name paired with an account key. Both authorise with a shared key, which
 * is what lets a staged blob be server-side copied to its content address within the same account
 * without minting a SAS. Managed identity is deliberately absent: it would pull in `@azure/identity`
 * and force a user-delegation SAS on every copy, and an operator on it can still use a connection
 * string.
 */
export type AzureConfig =
  | { readonly container: string; readonly connectionString: string }
  | { readonly container: string; readonly account: string; readonly accountKey: string };

export function createAzureContainerClient(config: AzureConfig): ContainerClient {
  const service =
    "connectionString" in config
      ? BlobServiceClient.fromConnectionString(config.connectionString)
      : new BlobServiceClient(
          `https://${config.account}.blob.core.windows.net`,
          new StorageSharedKeyCredential(config.account, config.accountKey)
        );
  return service.getContainerClient(config.container);
}

/**
 * Translates the narrow block-blob surface onto the Azure SDK, and holds no logic of its own.
 *
 * The SDK is here rather than a hand-written REST client and SharedKey signer because signing is a
 * security protocol whose failure mode is a request either refused or, worse, accepted differently
 * than intended. This layer is deliberately branch-free so that everything worth testing lives
 * above it, in `AzureBlobPort`, where the conformance suite can reach it.
 */
export class AzureSdkBlobApi implements AzureBlobApi {
  constructor(private readonly container: ContainerClient) {}

  async put(request: AzurePutRequest): Promise<void> {
    await this.container
      .getBlockBlobClient(request.key)
      .upload(request.body, request.body.byteLength, {
        ...(request.contentType === undefined
          ? {}
          : { blobHTTPHeaders: { blobContentType: request.contentType } }),
      });
  }

  async get(request: AzureGetRequest): Promise<AsyncIterable<Uint8Array>> {
    const range = request.range;
    const offset = range?.start ?? 0;
    const count =
      range === undefined || range.end === undefined ? undefined : range.end - range.start + 1;
    try {
      const response = await this.container.getBlobClient(request.key).download(offset, count);
      const body = response.readableStreamBody;
      if (body === undefined) throw new AzureBlobNotFoundError(request.key);
      return body as unknown as AsyncIterable<Uint8Array>;
    } catch (error) {
      throw normalize(error, request.key);
    }
  }

  async head(key: string): Promise<AzureObjectHead | null> {
    try {
      const props = await this.container.getBlobClient(key).getProperties();
      return {
        size: props.contentLength ?? 0,
        ...(props.contentType === undefined ? {} : { contentType: props.contentType }),
      };
    } catch (error) {
      if (normalize(error, key) instanceof AzureBlobNotFoundError) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.container.getBlobClient(key).deleteIfExists();
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const source = this.container.getBlobClient(sourceKey);
    const poller = await this.container.getBlobClient(destinationKey).beginCopyFromURL(source.url);
    await poller.pollUntilDone();
  }

  async stageBlock(key: string, blockId: string, body: Uint8Array): Promise<void> {
    await this.container.getBlockBlobClient(key).stageBlock(blockId, body, body.byteLength);
  }

  async commitBlockList(
    key: string,
    blockIds: readonly string[],
    contentType?: string
  ): Promise<void> {
    await this.container.getBlockBlobClient(key).commitBlockList([...blockIds], {
      ...(contentType === undefined ? {} : { blobHTTPHeaders: { blobContentType: contentType } }),
    });
  }
}

/**
 * A missing blob surfaces as a 404 `RestError` or a `BlobNotFound` code depending on the call, so
 * both become the same error before anything above here sees it.
 */
function normalize(error: unknown, key: string): unknown {
  const status = error instanceof RestError ? error.statusCode : undefined;
  const code = (error as { code?: string })?.code;
  return status === 404 || code === "BlobNotFound" ? new AzureBlobNotFoundError(key) : error;
}
