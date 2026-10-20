// Shared by the browser bundle and vite.config.ts so the API client and the HTML
// preconnect hint always name the same origin. Production builds without VITE_API_URL
// call the API on the page's own origin (self-host serves both behind one proxy), so
// vite.config.ts passes no `sameOrigin` and gets `undefined`: no preconnect is needed.
export function resolveApiOrigin(configured: string | undefined, development: boolean, sameOrigin?: string) {
  return configured || (development ? 'http://localhost:3001' : sameOrigin);
}
