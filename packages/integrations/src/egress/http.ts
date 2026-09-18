import type { IntegrationHttpMethod, IntegrationHttpResponse } from "../http";

export interface EgressMultipartPart {
  readonly byteLength?: number;
  readonly name: string;
  readonly body: string | AsyncIterable<Uint8Array>;
  readonly filename?: string;
  readonly mediaType?: string;
}

export interface EgressBinaryResponse {
  readonly headers: Readonly<Record<string, string>>;
  readonly declaredBytes: number;
  readonly body: AsyncIterable<Uint8Array>;
}

/** One resolved HTTP request; no provider operation or manifest interpretation. */
export interface EgressHttpRequest {
  readonly url: string;
  readonly method: IntegrationHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Already serialized non-JSON content; unlike a JSON string, it is sent verbatim. */
  readonly bodyText?: string;
  readonly multipart?: readonly EgressMultipartPart[];
  readonly multipartSubtype?: "related";
  /** Validated DNS answers are pinned at the socket; the transport must not resolve again. */
  readonly pinnedAddresses?: readonly string[];
  readonly maxResponseBytes?: number;
  readonly acceptBinary?: boolean;
  readonly binaryResponse?: (response: EgressBinaryResponse) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

export interface EgressHttpPort {
  send(request: EgressHttpRequest): Promise<IntegrationHttpResponse>;
}
