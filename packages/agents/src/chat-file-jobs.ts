import { z } from 'zod';
import { canonicalJson } from '@tulipfarm/tables/canonical';

export const fileJobCallLimit = 50;
export const fileListingFailed = "I couldn't list your files. Ask me to try again.";
export const fileListingEmpty = "I didn't find any files that match your search.";
const saveFailed = "I couldn't save the file. Ask me to try again.";
const repeatedFailure = 'I stopped because the same file request kept failing.';
const fileRequest = /\b(?:files?|workbooks?|spreadsheets?|documents?|xlsx|docx|pptx|markdown)\b/i;
const saveRequest = /\b(?:create|make|save|generate|write|export)\b/i;
const fileSavedClaim = /\b(?:ready|saved|created|generated|made|download)\b|\bhere(?:'s| is| are)\b/i;
export function newFileRequested(request: string) {
  return (
    fileRequest.test(request) &&
    saveRequest.test(request) &&
    !/\b(?:from|using|based on|attached|attachment|existing|read|copy|folder|rename|and|then|also|table|agent|workflow|skill|images?|photos?|pictures?|how|explain)\b/i.test(
      request,
    )
  );
}
const receipt = z.object({
  file: z.object({
    id: z.uuid(),
    name: z.string(),
    mediaType: z.string(),
    size: z.number(),
    parentId: z.string().nullable(),
  }),
});
const failure = z.object({ error: z.string(), instruction: z.string().optional() });

/** Only standalone library lookups are routed here; requests to read or change their contents stay with the model. */
export function fileListingQuery(request: string): string | undefined {
  const match =
    /\b(?:names?\s+(?:contains?|includes?|matches?)|named?|called|matching|search(?:\s+(?:my\s+)?files)?\s+for)\s+["'“]?(.+?)["'”]?[.!?]?\s*$/i.exec(
      request,
    );
  const intent = match ? request.slice(0, request.lastIndexOf(match[1]!)) : request;
  if (
    !/\b(?:list|show|find|search)\b/i.test(intent) ||
    !/\b(?:files?|library)\b/i.test(intent) ||
    /\b(?:create|make|save|write|summari[sz]e|read|delete|move|rename|restore|trash|explain|how to|tables?|rows?|records?|fields?|people|teams?|members?)\b/i.test(
      intent,
    )
  )
    return undefined;
  return match
    ? match[1]!
        .replace(/["'”]$/, '')
        .trim()
        .slice(0, 255)
    : '';
}

export function createFileJobGuard(request: string, prior: readonly { call: unknown; result: unknown }[] = []) {
  let active = false;
  let attempted = false;
  let saved = false;
  let lastFailure: z.infer<typeof failure> | undefined;
  const failures = new Map<string, number>();
  let repeated = false;
  let needsListing = false;
  const record = (call: { tool: string }, value: unknown) => {
    if (!call.tool.startsWith('files.')) return;
    active = true;
    if (call.tool === 'files.read') needsListing = failure.safeParse(value).success;
    if (call.tool === 'files.list' && !failure.safeParse(value).success) needsListing = false;
    if (call.tool === 'files.create') {
      attempted = true;
      if (receipt.safeParse(value).success) saved = true;
      const parsed = failure.safeParse(value);
      if (parsed.success) lastFailure = parsed.data;
    }
    const parsed = failure.safeParse(value);
    if (parsed.success) {
      const key = canonicalJson([call, parsed.data.error]);
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      repeated ||= count >= 3;
    }
  };
  for (const entry of prior) {
    const call = z.object({ tool: z.string() }).passthrough().safeParse(entry.call);
    if (call.success) record(call.data, entry.result);
  }
  return {
    get active() {
      return active;
    },
    get saved() {
      return saved;
    },
    get holdPreview() {
      return !saved && (active || newFileRequested(request) || fileListingQuery(request) !== undefined);
    },
    get stopped() {
      return repeated;
    },
    get needsListing() {
      return needsListing;
    },
    admit(names: readonly string[]) {
      active ||= names.some(name => name.startsWith('files_'));
    },
    record,
    unbacked(text: string) {
      return !saved && (active || newFileRequested(request)) && saveRequest.test(request) && fileSavedClaim.test(text);
    },
    reply() {
      if (saved) return undefined;
      if (repeated) return `${repeatedFailure}${attempted ? ' No file was saved.' : ''} Ask me to try again.`;
      if (!attempted) return undefined;
      if (lastFailure?.error === 'quota')
        return "I couldn't save the file because workspace storage is full. Free up some space, then ask me to try again.";
      if (lastFailure?.error === 'invalid-content' && lastFailure.instruction) {
        let reason = lastFailure.instruction
          .replace(/^No file was created\.\s*/i, '')
          .trim()
          .slice(0, 400);
        if (reason) {
          reason = reason[0]!.toUpperCase() + reason.slice(1).replace(/[.!?]+$/, '') + '.';
          return `I couldn't save the file because part of it isn't valid. ${reason} Ask me to fix it and try again.`;
        }
      }
      return saveFailed;
    },
    missingSaveReply: saveFailed,
  };
}
