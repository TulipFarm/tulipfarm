import { isIP } from "node:net";
import { McpError } from "@tulipfarm/mcp";
import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicEgressUrl, GuardedEgressHttp } from "../egress/destination";
import type { EgressHttpRequest } from "../egress/http";

export interface McpGuardedFetchOptions {
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly fetch?: typeof undiciFetch;
}

/** Pins validated DNS answers without buffering Streamable HTTP event streams. */
export function createMcpGuardedFetch(options: McpGuardedFetchOptions = {}) {
  const fetch = options.fetch ?? undiciFetch;
  async function stream(request: EgressHttpRequest): Promise<Response> {
    const pinned = request.pinnedAddresses?.[0];
    if (!pinned) throw new McpError("access_denied");
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          const family = isIP(pinned);
          if (options.all) callback(null, [{ address: pinned, family }]);
          else callback(null, pinned, family);
        },
      },
    });
    const signal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(request.signal ? [request.signal] : []),
    ]);
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.bodyText === undefined ? {} : { body: request.bodyText }),
        dispatcher,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      await dispatcher.destroy();
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      await dispatcher.destroy();
      throw new McpError("access_denied");
    }
    const headers = new Headers([...response.headers]);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const reader = response.body?.getReader();
    if (!reader) {
      await dispatcher.destroy();
      return new Response(null, { status: response.status, headers });
    }
    let received = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            await dispatcher.destroy();
            return;
          }
          received += chunk.value.byteLength;
          if (received > 8 * 1024 * 1024) throw new McpError("response_limit");
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          await dispatcher.destroy();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await dispatcher.destroy();
        }
      },
    });
    return new Response(body, { status: response.status, headers });
  }
  const http = new GuardedEgressHttp(
    {
      async send(request) {
        const response = await stream(request);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: response,
        };
      },
    },
    { resolve: options.resolve, ttlMs: 0 }
  );
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    assertPublicEgressUrl(url, url.origin);
    const method = init.method?.toUpperCase() ?? "GET";
    if (
      method !== "GET" &&
      method !== "POST" &&
      method !== "DELETE" &&
      method !== "PUT" &&
      method !== "PATCH" &&
      method !== "HEAD" &&
      method !== "OPTIONS"
    ) {
      throw new McpError("invalid_configuration");
    }
    if (
      init.body != null &&
      typeof init.body !== "string" &&
      !(init.body instanceof URLSearchParams)
    )
      throw new McpError("invalid_configuration");
    const response = await http.send({
      url: url.href,
      method,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.body == null ? {} : { bodyText: init.body.toString() }),
      signal: init.signal ?? undefined,
    });
    if (!(response.body instanceof Response)) throw new McpError("access_denied");
    return response.body;
  };
}
