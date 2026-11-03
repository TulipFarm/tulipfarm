import { SecretError, type Placement, type PlacementKind, type SecretValue } from './contracts.ts';

export type OutgoingRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
};

function single(value: SecretValue) {
  if (!('value' in value)) throw new SecretError('placement-unsupported');
  return value.value;
}

function setPath(target: Record<string, unknown>, path: string, value: string) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === undefined) node = node[part] = {};
    else if (next && typeof next === 'object' && !Array.isArray(next)) node = next as Record<string, unknown>;
    else throw new SecretError('invalid-input');
  }
  const last = parts.at(-1)!;
  if (last in node) throw new SecretError('invalid-input');
  node[last] = value;
}

/**
 * Inserts a secret into an outgoing request in its stored placement. The caller's request must not already
 * set what the placement sets, so an agent cannot shadow or duplicate the secret.
 */
export function applyPlacement(
  request: OutgoingRequest,
  placement: Placement,
  value: SecretValue,
  supported: readonly PlacementKind[],
): OutgoingRequest {
  if (!supported.includes(placement.kind)) throw new SecretError('placement-unsupported');
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(request.headers).map(([name, header]) => [name.toLowerCase(), header]),
  );
  const claim = (name: string, header: string) => {
    if (name in headers) throw new SecretError('invalid-input');
    headers[name] = header;
  };
  switch (placement.kind) {
    case 'bearer':
      claim('authorization', `Bearer ${single(value)}`);
      return { ...request, headers };
    case 'basic': {
      const pair = 'value' in value ? `${value.value}:` : `${value.username}:${value.password}`;
      claim('authorization', `Basic ${Buffer.from(pair).toString('base64')}`);
      return { ...request, headers };
    }
    case 'header':
      claim(placement.name, single(value));
      return { ...request, headers };
    case 'cookie': {
      const cookies = headers.cookie ? headers.cookie.split(/;\s*/) : [];
      if (cookies.some(cookie => cookie.split('=')[0] === placement.name)) throw new SecretError('invalid-input');
      cookies.push(`${placement.name}=${encodeURIComponent(single(value))}`);
      headers.cookie = cookies.join('; ');
      return { ...request, headers };
    }
    case 'query': {
      const url = new URL(request.url);
      if (url.searchParams.has(placement.name)) throw new SecretError('invalid-input');
      url.searchParams.set(placement.name, single(value));
      return { ...request, url: url.href, headers };
    }
    case 'body': {
      const parts = 'value' in value ? [value.value] : [value.username, value.password];
      if (parts.length !== placement.fields.length) throw new SecretError('placement-unsupported');
      if (placement.format === 'form') {
        const form = new URLSearchParams(request.body ?? '');
        placement.fields.forEach((field, index) => {
          if (form.has(field)) throw new SecretError('invalid-input');
          form.set(field, parts[index]!);
        });
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
        return { ...request, headers, body: form.toString() };
      }
      let json: unknown;
      try {
        json = request.body ? JSON.parse(request.body) : {};
      } catch {
        throw new SecretError('invalid-input');
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SecretError('invalid-input');
      placement.fields.forEach((field, index) => setPath(json as Record<string, unknown>, field, parts[index]!));
      headers['content-type'] ??= 'application/json';
      return { ...request, headers, body: JSON.stringify(json) };
    }
  }
}

/** Removes query-parameter secrets from a URL before it is logged, stored or shown. */
export function redactUrl(url: string, placements: readonly Placement[]): string {
  const names = placements.flatMap(placement => (placement.kind === 'query' ? [placement.name] : []));
  if (!names.length) return url;
  try {
    const parsed = new URL(url);
    for (const name of names) parsed.searchParams.delete(name);
    return parsed.href;
  } catch {
    return url;
  }
}
