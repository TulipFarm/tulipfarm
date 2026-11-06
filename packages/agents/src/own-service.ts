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
  code: 'own-service',
  message:
    'Nothing was sent: api.request cannot call TulipFarm itself. Use the built-in tool for the job instead, such as tables.propose to create or change tables, rows tools for records, and files or knowledge tools for documents.',
} as const;
