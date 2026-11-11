import { z } from 'zod';
import { canonicalJson } from '@tulipfarm/tables/canonical';

export const fileJobCallLimit = 50;
export const fileListingFailed = "I couldn't list your files. Ask me to try again.";
export const fileListingEmpty = "I didn't find any files that match your search.";
const saveFailed = "I couldn't save the file. Ask me to try again.";
const repeatedFailure = 'I stopped because the same file request kept failing.';
const fileRequest = /\b(?:files?|workbooks?|spreadsheets?|documents?|md|xlsx|docx|pptx|markdown)\b/i;
const saveRequest =
  /(?:^|[.!?;\n]\s*|\b(?:and|then|also)\s+)(?:please\s+)?(?:(?:can|could|would) you (?:please )?)?(?:create|make|save|generate|write|export)\s+(.+?)(?=$|[!?;\n]|\.(?:\s|$)|\b(?:and|then|also)\b)/gi;
const fileSubject = String.raw`(?:files?|workbooks?|spreadsheets?|documents?|\S+\.(?:md|txt|csv|json|docx|xlsx|pptx))\b`;
const fileSavedClaim = new RegExp(
  [
    String.raw`\b(?:saved|created|ready)\s+in\s+(?:(?:my|your)\s+)?Files\b`,
    String.raw`\b(?:saved|created)\b[^.!?\n]*\b(?:in|to)\s+(?:(?:my|your|the)\s+)?Files\b`,
    String.raw`(?:\b(?:I|we)(?:['’]ve| have)?\s+|^)(?:(?:just|successfully|now)\s+)?(?:saved|created|generated|made|exported)\s+(?:(?:a|an|the|your|my|new|Excel|markdown)\s+)*${fileSubject}`,
    String.raw`\b${fileSubject}\s+(?:is|are|has been|have been)\s+(?:(?:now|successfully)\s+)?(?:saved|created)\b`,
  ].join('|'),
  'i',
);
function fileSaveRequested(request: string) {
  for (const match of request.matchAll(saveRequest)) {
    const object = match[1]!.split(/\b(?:from|using|based on|of|about|that|for)\b/i)[0]!;
    if (fileRequest.test(object)) return true;
  }
  return false;
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
    /^(?:please\s+)?(?:list|show(?:\s+me)?|find|search(?:\s+for)?)\s+(?:(?:all|the|my)\s+)*(?:files|library)(?:\s+in\s+(?:my\s+)?(?:files|library))?(?:\s+(?:(?:whose\s+)?names?\s+(?:contains?|includes?|matches?)|named|called|matching|for)\s+(.+))?$/i.exec(
      request
        .trim()
        .replace(/[.!?]$/, '')
        .trim(),
    );
  if (!match) return undefined;
  if (!match[1]) return '';
  const query = /^(?:"([^"]+)"|'([^']+)'|“([^”]+)”|([^\s"'“”]+))$/.exec(match[1].trim());
  return query?.slice(1).find(Boolean)?.slice(0, 255);
}

export function createFileJobGuard(request: string, prior: readonly { call: unknown; result: unknown }[] = []) {
  const requestedSave = fileSaveRequested(request);
  let calls = 0;
  let attempted = false;
  let saved = false;
  let lastFailure: z.infer<typeof failure> | undefined;
  const failures = new Map<string, number>();
  let repeated = false;
  let needsListing = false;
  const record = (call: { tool: string }, value: unknown) => {
    if (!call.tool.startsWith('files.')) return;
    calls++;
    const parsed = failure.safeParse(value);
    if (call.tool === 'files.read') {
      needsListing =
        parsed.success && (parsed.data.error === 'file-source-required' || parsed.data.error === 'file-not-found');
    }
    if (call.tool === 'files.list' && !parsed.success) needsListing = false;
    if (call.tool === 'files.create') {
      attempted = true;
      if (receipt.safeParse(value).success) saved = true;
      if (parsed.success) lastFailure = parsed.data;
    }
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
    get remainingCalls() {
      return Math.max(0, fileJobCallLimit - calls);
    },
    get saved() {
      return saved;
    },
    get requestedSave() {
      return requestedSave;
    },
    get holdPreview() {
      return !saved && (attempted || requestedSave || fileListingQuery(request) !== undefined);
    },
    get stopped() {
      return repeated;
    },
    get needsListing() {
      return needsListing;
    },
    prepare(names: readonly string[]) {
      attempted ||= names.includes('files_create');
    },
    record,
    unbacked(text: string) {
      return !saved && (requestedSave || fileSavedClaim.test(text));
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
