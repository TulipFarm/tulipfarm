/** Assembles a minimal RFC 2822 message and encodes it base64url for Gmail's `message.raw`. */

export interface GmailMimeMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return true;
  }
  return false;
}

/** RFC 2047 encoded-word for headers carrying non-ASCII text; ASCII passes through untouched. */
function encodeHeaderValue(value: string): string {
  if (!hasNonAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Drops CR/LF so a header value cannot inject extra headers. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function header(name: string, value: string): string {
  return `${name}: ${encodeHeaderValue(sanitizeHeaderValue(value))}`;
}

/** Builds the raw message text; recipients are caller-validated, headers are CRLF-sanitized. */
export function buildGmailMime(message: GmailMimeMessage): string {
  const lines = [
    header("To", message.to),
    ...(message.cc === undefined || message.cc.length === 0 ? [] : [header("Cc", message.cc)]),
    ...(message.bcc === undefined || message.bcc.length === 0 ? [] : [header("Bcc", message.bcc)]),
    header("Subject", message.subject),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    message.body,
  ];
  return lines.join("\r\n");
}

/** Gmail expects the raw message base64url-encoded. */
export function encodeGmailRaw(message: GmailMimeMessage): string {
  return Buffer.from(buildGmailMime(message), "utf8").toString("base64url");
}
