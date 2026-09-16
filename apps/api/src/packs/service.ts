import { createHash } from "node:crypto";
import { PACK_CATALOG_URL } from "@tulipfarm/constants/site";
import {
  assertPublicEgressUrl,
  type EgressHttpPort,
  egressDenialReason,
  FetchEgressHttp,
  GuardedEgressHttp,
  sendGovernedRequest,
} from "@tulipfarm/integrations";
import { compileYamlPlan } from "@tulipfarm/run-kernel";
import {
  ajv,
  isRecord,
  PACK_MAX_BYTES,
  PACK_READ_MAX_RESULT_CHARS,
  type PackCatalogEntry,
  PackCatalogSchema,
  type PackPreview,
  type PackSource,
  PackSourceSchema,
  parseYamlDocument,
  validatePackDefinition,
} from "@tulipfarm/schema";
import { stringify } from "yaml";

const validateSource = ajv.compile<PackSource>(PackSourceSchema);
const validateCatalog = ajv.compile<{ packs: PackCatalogEntry[] }>(PackCatalogSchema);
const TIMEOUT_MS = 15_000;

export class PackReadError extends Error {
  constructor(
    readonly status: 400 | 502,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface PackReadOptions {
  readonly signal?: AbortSignal;
  readonly assertDestination?: (origin: string) => void;
  readonly expectedSha256?: string;
}

export class PackService {
  constructor(
    private readonly http: EgressHttpPort = new GuardedEgressHttp(
      new FetchEgressHttp({ maxResponseBytes: PACK_MAX_BYTES, timeoutMs: TIMEOUT_MS })
    )
  ) {}

  async preview(source: PackSource, options: PackReadOptions = {}): Promise<PackPreview> {
    if (!validateSource(source)) {
      throw new PackReadError(400, "validation_error", "Provide exactly one of url or yaml.");
    }
    const fetched = "url" in source ? await this.read(source.url, options) : undefined;
    const yaml = fetched?.text ?? ("yaml" in source ? source.yaml : "");
    assertBound(yaml);
    const sha256 = createHash("sha256").update(yaml).digest("hex");
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
      throw new PackReadError(
        400,
        "source_changed",
        "The Pack source does not match the reviewed SHA-256. Obtain a fresh preview and confirmation; do not retry without the expected hash."
      );
    }
    try {
      const document = parseYamlDocument(yaml);
      if (isRecord(document) && document.kind === "Plan") {
        throw new Error(
          "This is an ordinary YAML Plan, not a Pack. Use plan_compile with its complete source."
        );
      }
      const { document: pack } = validatePackDefinition(document);
      const identities = new Set(
        pack.artifacts.map((artifact) => `${artifact.kind}:${artifact.name}`)
      );
      if (identities.size !== pack.artifacts.length) {
        throw new Error("Artifact kind/name pairs must be unique.");
      }
      compileYamlPlan(stringify(pack.plan));
      const result: PackPreview = {
        pack,
        sha256,
        ...(fetched === undefined ? {} : { url: fetched.url }),
      };
      if (JSON.stringify(result).length > PACK_READ_MAX_RESULT_CHARS) {
        throw new PackReadError(
          400,
          "pack_too_large",
          `The complete Pack exceeds the ${PACK_READ_MAX_RESULT_CHARS}-character Chat preview limit. Ask for a smaller Pack; no partial source was returned.`
        );
      }
      return result;
    } catch (error) {
      if (error instanceof PackReadError) throw error;
      throw new PackReadError(
        400,
        "validation_error",
        error instanceof Error ? error.message : "Invalid Pack."
      );
    }
  }

  async catalog(): Promise<{ packs: PackCatalogEntry[] }> {
    const { text } = await this.read(PACK_CATALOG_URL);
    let catalog: unknown;
    try {
      catalog = JSON.parse(text);
    } catch {
      throw new PackReadError(502, "invalid_catalog", "The Pack catalog is not valid JSON.");
    }
    if (!validateCatalog(catalog)) {
      throw new PackReadError(502, "invalid_catalog", "The Pack catalog has an invalid shape.");
    }
    const names = new Set<string>();
    for (const pack of catalog.packs) {
      try {
        assertPublicEgressUrl(new URL(pack.url), pack.url);
        if (names.has(pack.name)) throw new Error("duplicate");
        names.add(pack.name);
      } catch {
        throw new PackReadError(502, "invalid_catalog", "The Pack catalog has an invalid entry.");
      }
    }
    return catalog;
  }

  private async read(url: string, options: PackReadOptions = {}) {
    try {
      assertPublicEgressUrl(new URL(url), url);
      options.assertDestination?.(new URL(url).origin);
    } catch {
      throw new PackReadError(
        400,
        "destination_refused",
        "Use a public HTTPS URL without credentials."
      );
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    try {
      const result = await readBeforeAbort(signal, () =>
        sendGovernedRequest(
          {
            send: (request) =>
              this.http.send({
                ...request,
                maxResponseBytes: PACK_MAX_BYTES,
                binaryResponse: async ({ body }) => {
                  const chunks: Uint8Array[] = [];
                  let size = 0;
                  for await (const chunk of body) {
                    size += chunk.byteLength;
                    if (size > PACK_MAX_BYTES) throw new Error("Pack exceeds byte limit.");
                    chunks.push(chunk);
                  }
                  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                    Buffer.concat(chunks)
                  );
                },
              }),
          },
          {
            url,
            method: "GET",
            headers: { accept: "application/yaml, text/yaml, application/json, text/plain" },
            signal,
            ...(options.assertDestination === undefined
              ? {}
              : { assertDestination: options.assertDestination }),
          },
          3
        )
      );
      if (result.kind !== "response") throw new Error("Pack redirects are not accessible.");
      const { response } = result;
      if (egressDenialReason(response.status, response.body) !== undefined) {
        throw new PackReadError(400, "destination_refused", "The Pack destination is not public.");
      }
      if (response.status < 200 || response.status >= 300 || typeof response.body !== "string") {
        throw new Error("Pack source is inaccessible or exceeds the byte limit.");
      }
      assertBound(response.body);
      return { text: response.body, url: result.url };
    } catch (error) {
      if (error instanceof PackReadError) throw error;
      throw new PackReadError(502, "upstream_error", "Could not read the complete Pack source.");
    }
  }
}

/** DNS resolution is not abort-aware; the same signal still fences its eventual socket request. */
async function readBeforeAbort<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([read(), cancelled]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function assertBound(source: string): void {
  if (Buffer.byteLength(source, "utf8") > PACK_MAX_BYTES) {
    throw new PackReadError(
      400,
      "validation_error",
      `Pack source exceeds ${PACK_MAX_BYTES} bytes.`
    );
  }
}
