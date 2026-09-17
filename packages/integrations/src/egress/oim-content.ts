import { AdapterDispatchError, type ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { buildMimeMessage, type MimeAttachment } from "./mime-message";
import type { OimFilePort } from "./oim-files";

export async function boundedFileContent(
  files: OimFilePort | undefined,
  input: { readonly businessId: string; readonly principalId: string; readonly fileId: string },
  maxBytes: number
): Promise<MimeAttachment> {
  if (files === undefined)
    throw new AdapterDispatchError("before_dispatch", "file_port_missing", false);
  let content: Awaited<ReturnType<OimFilePort["content"]>>;
  try {
    content = await files.content(input);
  } catch {
    throw new AdapterDispatchError("before_dispatch", "file_access_denied", false);
  }
  if (content.file.id !== input.fileId) {
    throw new AdapterDispatchError("before_dispatch", "file_id_mismatch", false);
  }
  if (
    !Number.isSafeInteger(content.file.sizeBytes) ||
    content.file.sizeBytes < 0 ||
    content.file.sizeBytes > maxBytes
  ) {
    throw new AdapterDispatchError("before_dispatch", "request_too_large", false);
  }
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(content.file.mediaType)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_file_media_type", false);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content.body) {
    size += chunk.byteLength;
    if (size > maxBytes)
      throw new AdapterDispatchError("before_dispatch", "request_too_large", false);
    chunks.push(Uint8Array.from(chunk));
  }
  if (size !== content.file.sizeBytes) {
    throw new AdapterDispatchError("before_dispatch", "file_size_mismatch", false);
  }
  return {
    filename: content.file.filename,
    mediaType: content.file.mediaType,
    bytes: Buffer.concat(chunks, size),
  };
}

export async function prepareMimeBody(input: {
  readonly body: unknown;
  readonly request: ToolAdapterRequest;
  readonly principalId: string;
  readonly files: OimFilePort | undefined;
  readonly maxBytes: number;
  readonly outputPointer: string;
}): Promise<unknown> {
  const invalid = () => new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  if (input.body === null || typeof input.body !== "object" || Array.isArray(input.body))
    throw invalid();
  const body = input.body as Record<string, unknown>;
  const keys = new Set(["to", "cc", "bcc", "subject", "text", "html", "attachments"]);
  if (Object.keys(body).some((key) => !keys.has(key))) throw invalid();
  for (const key of ["to", "cc", "bcc", "subject"]) {
    const value = body[key];
    if (value === undefined && (key === "cc" || key === "bcc")) continue;
    if (
      typeof value !== "string" ||
      (key === "to" && value.length === 0) ||
      Buffer.byteLength(value) > 900 ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw invalid();
    if (key !== "subject" && !/^[\x20-\x7e]*$/.test(value)) throw invalid();
  }
  if (body.text === undefined && body.html === undefined) throw invalid();
  for (const key of ["text", "html"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") throw invalid();
  }
  if (Buffer.byteLength(JSON.stringify(body)) > input.maxBytes) {
    throw new AdapterDispatchError("before_dispatch", "request_too_large", false);
  }
  const fileIds = body.attachments ?? [];
  if (
    !Array.isArray(fileIds) ||
    fileIds.length > 10 ||
    fileIds.some((id) => typeof id !== "string")
  )
    throw invalid();
  const attachments: MimeAttachment[] = [];
  let remaining = input.maxBytes;
  for (const fileId of fileIds) {
    const attachment = await boundedFileContent(
      input.files,
      {
        businessId: input.request.intent.businessId,
        principalId: input.principalId,
        fileId,
      },
      remaining
    );
    remaining -= attachment.bytes.byteLength;
    attachments.push(attachment);
  }
  const mime = buildMimeMessage(
    body as {
      to: string;
      subject: string;
      text?: string;
      html?: string;
      cc?: string;
      bcc?: string;
    },
    attachments
  );
  let output: unknown = Buffer.from(mime, "utf8").toString("base64url");
  const segments = input.outputPointer.slice(1).split("/");
  if (
    !/^\/[A-Za-z]/.test(input.outputPointer) ||
    segments.some(
      (key) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
        ["constructor", "prototype", "__proto__"].includes(key)
    )
  )
    throw invalid();
  for (const segment of segments.reverse()) output = { [segment]: output };
  if (Buffer.byteLength(JSON.stringify(output)) > input.maxBytes) {
    throw new AdapterDispatchError("before_dispatch", "request_too_large", false);
  }
  return output;
}
