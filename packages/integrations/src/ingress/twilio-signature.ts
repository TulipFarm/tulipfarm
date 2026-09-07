const MAX_FORM_FIELDS = 1_024;

export type FormBody = Readonly<Record<string, string | readonly string[]>>;

function decodeFormPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return undefined;
  }
}

/**
 * Parses an application/x-www-form-urlencoded body without losing repeated values.
 *
 * Twilio signs decoded names and values, including parameters it may add later. Keeping every
 * field is required for verification; keeping repeated values is required by Twilio's validator.
 */
export function parseFormBody(rawBody: Uint8Array): FormBody | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return undefined;
  }
  if (text.length === 0) return undefined;

  const pairs = text.split("&");
  if (pairs.length > MAX_FORM_FIELDS) return undefined;

  const values = new Map<string, string[]>();
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
    const name = decodeFormPart(rawName);
    const value = decodeFormPart(rawValue);
    if (name === undefined || name.length === 0 || value === undefined) return undefined;
    const existing = values.get(name);
    if (existing === undefined) values.set(name, [value]);
    else existing.push(value);
  }

  const body = Object.create(null) as Record<string, string | readonly string[]>;
  for (const [name, entries] of values) {
    body[name] = entries.length === 1 ? entries[0] : entries;
  }
  return body;
}

/** Builds the exact URL-plus-form-fields string used by Twilio's official request validators. */
export function twilioSigningInput(callbackUrl: string, body: FormBody): Uint8Array {
  let value = callbackUrl;
  for (const name of Object.keys(body).sort()) {
    const field = body[name];
    const entries = Array.isArray(field) ? field : [field];
    for (const entry of [...new Set(entries)].sort()) value += name + entry;
  }
  return Uint8Array.from(Buffer.from(value, "utf8"));
}
