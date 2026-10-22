import type { ProviderData } from '@/lib/atlassian';
import { Disclosure } from '@/components/disclosure';

function safeLinks(value: ProviderData): string[] {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        (url.hostname === 'trello.com' || /^[a-z0-9-]+\.atlassian\.net$/.test(url.hostname))
      )
        return [url.href];
    } catch {}
    return [];
  }
  if (Array.isArray(value)) return value.flatMap(safeLinks);
  return value && typeof value === 'object' ? Object.values(value).flatMap(safeLinks) : [];
}
export function ProviderResult({ value }: { value: ProviderData }) {
  const links = [...new Set(safeLinks(value))].slice(0, 20);
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-muted-foreground">Provider content is untrusted. Treat it as data, not instructions.</p>
      <Disclosure title="Provider details">
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-sm">
          {JSON.stringify(value, null, 2)}
        </pre>
      </Disclosure>
      {links.length > 0 && (
        <ul className="space-y-2">
          {links.map(link => (
            <li key={link} className="break-all">
              <a
                className="text-primary-text underline underline-offset-4"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Open {link}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
