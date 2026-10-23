/** Sent through the `analytics` web slot each time the route error page ("Could not open TulipFarm") renders. */
export const routeErrorEvent = 'route_error_shown';

export type RouteErrorProperties = {
  /** `asset`: page code failed to load; `request`: an API answered with an error status; `network`: fetch failed. */
  kind: 'asset' | 'request' | 'network' | 'other';
  /** The API status for `request` errors. */
  status?: number;
  /** A built-in error class name, never the message. */
  errorType: string;
};

const errorTypes = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError']);

/** Classifies a route error without its message, URL or stack, so reports carry no user text. */
export function routeErrorProperties(error: unknown, assetFailure: boolean): RouteErrorProperties {
  const name = error instanceof Error ? error.name : '';
  const errorType = errorTypes.has(name) ? name : 'Error';
  if (assetFailure) return { kind: 'asset', errorType };
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
    return { kind: 'request', status, errorType };
  // fetch rejects with a TypeError when the request never got a response.
  if (error instanceof TypeError) return { kind: 'network', errorType };
  return { kind: 'other', errorType };
}
