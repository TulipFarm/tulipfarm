/** This deployment's own domains: each public origin's host and, below a domain, its parent (app.example.com → example.com). */
export function ownServiceDomains(
  origins: readonly (string | undefined)[] = [
    process.env.WEB_ORIGIN,
    process.env.BETTER_AUTH_URL,
    process.env.WEBSITE_ORIGIN,
  ],
): string[] {
  const domains = new Set<string>();
  for (const value of origins) {
    if (!value) continue;
    let host: string;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      continue;
    }
    domains.add(host);
    const labels = host.split('.');
    if (labels.length > 2 && !/^\d+$/.test(labels.at(-1)!)) domains.add(labels.slice(1).join('.'));
  }
  return [...domains];
}

export function isOwnServiceUrl(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export const ownServiceRefusal = {
  status: 'failed',
  code: 'address-denied',
  message: "Nothing was sent. This tool can't call TulipFarm itself. Use the built-in tools for this task instead.",
} as const;

export function ownServiceCorrection(url: string, admitted: readonly string[]): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const family = new URL(url).pathname
    .toLowerCase()
    .split('/')
    .reverse()
    .find(segment => segment && segment !== 'api' && admitted.some(tool => tool.startsWith(`${segment}.`)));
  if (!family) return undefined;
  const names = [...new Set(admitted)]
    .filter(tool => tool.startsWith(`${family}.`))
    .slice(0, 8)
    .map(tool => tool.replaceAll('.', '_'));
  return `Available built-in tools: ${names.join(', ')}. Call tools_search with a listed name or purpose only if the tool is not already offered, then call the loaded tool on the next step.`;
}
