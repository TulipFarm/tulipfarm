import { randomUUID } from "node:crypto";

export interface MimeTextMessage {
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
export function buildTextMime(message: MimeTextMessage): string {
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

export function encodeTextMime(message: MimeTextMessage): string {
  return Buffer.from(buildTextMime(message), "utf8").toString("base64url");
}

export interface MimeAttachment {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

function base64Lines(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

function textPart(mediaType: string, value: string): string {
  return [
    `Content-Type: ${mediaType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(value.replace(/\r?\n/g, "\r\n"), "utf8")),
  ].join("\r\n");
}

function multipart(subtype: string, parts: readonly string[]): string {
  const boundary = `tulipfarm-${randomUUID()}`;
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    "",
    ...parts.map((part) => `--${boundary}\r\n${part}\r\n`),
    `--${boundary}--`,
  ].join("\r\n");
}

/** Composes UTF-8 MIME without interpreting model input as wire headers or encoded bytes. */
export function buildMimeMessage(
  message: {
    readonly to: string;
    readonly cc?: string;
    readonly bcc?: string;
    readonly subject: string;
    readonly text?: string;
    readonly html?: string;
  },
  attachments: readonly MimeAttachment[]
): string {
  const parts = [
    ...(message.text === undefined ? [] : [textPart("text/plain", message.text)]),
    ...(message.html === undefined ? [] : [textPart("text/html", message.html)]),
  ];
  let content =
    parts.length > 1 ? multipart("alternative", parts) : (parts[0] ?? textPart("text/plain", ""));
  if (attachments.length > 0) {
    content = multipart("mixed", [
      content,
      ...attachments.map((file) => {
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(file.mediaType))
          throw new Error("invalid_file_media_type");
        const filename = encodeURIComponent(file.filename).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        );
        return [
          `Content-Type: ${file.mediaType}`,
          `Content-Disposition: attachment; filename*=UTF-8''${filename}`,
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(file.bytes),
        ].join("\r\n");
      }),
    ]);
  }
  const subject = hasNonAscii(message.subject)
    ? [...message.subject]
        .reduce<string[]>((chunks, char) => {
          const last = chunks[chunks.length - 1];
          if (last === undefined || Buffer.byteLength(last + char) > 42) chunks.push(char);
          else chunks[chunks.length - 1] = last + char;
          return chunks;
        }, [])
        .map(encodeHeaderValue)
        .join("\r\n ")
    : message.subject;
  return [
    `To: ${message.to}`,
    ...(message.cc ? [`Cc: ${message.cc}`] : []),
    ...(message.bcc ? [`Bcc: ${message.bcc}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    content,
  ].join("\r\n");
}
