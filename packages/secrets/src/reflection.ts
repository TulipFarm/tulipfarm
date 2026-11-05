function decodeEntities(input: string) {
  return input
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (match: string, hex?: string, decimal?: string) => {
      const point = hex ? parseInt(hex, 16) : Number(decimal);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeUri(input: string) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input.replace(/%([0-9a-f]{2})/gi, (_match, code: string) => String.fromCharCode(parseInt(code, 16)));
  }
}

/**
 * True when `input` contains any secret in plain, URL-encoded, base64, base64url or HTML-escaped form,
 * including those encodings layered up to four times.
 */
export function containsSecret(input: unknown, secrets: readonly string[]): boolean {
  const patterns = secrets
    .filter(secret => secret.length >= 4)
    .flatMap(secret => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64').replace(/=+$/, ''),
      Buffer.from(secret).toString('base64url'),
    ]);
  if (!patterns.length) return false;
  const strings: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 32) return;
    if (typeof value === 'string') strings.push(value);
    else if (value instanceof Error) {
      strings.push(value.message);
      visit((value as { cause?: unknown }).cause, depth + 1);
    } else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        strings.push(key);
        visit(item, depth + 1);
      }
  };
  visit(input, 0);
  return strings.some(text => {
    let decoded = text;
    for (let round = 0; round < 4; round++) {
      if (patterns.some(pattern => decoded.includes(pattern))) return true;
      const next = decodeUri(decodeEntities(decoded));
      if (next === decoded) break;
      decoded = next;
    }
    return false;
  });
}
