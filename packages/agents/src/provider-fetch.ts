import { Agent } from 'undici';

// Node's fetch negotiates HTTP/2 and sends request bodies one at a time on a connection
// (nodejs/undici#5494), so concurrent model calls would queue behind each other.
// The undici package and Node's bundled fetch declare separate Dispatcher types.
const dispatcher = new Agent({ allowH2: false }) as unknown as NonNullable<RequestInit['dispatcher']>;

/** `fetch` for model providers, over HTTP/1.1 so concurrent requests run in parallel. */
export function providerFetch(input: string | URL, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, dispatcher });
}
