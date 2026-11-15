export function layoutPreviewHasRoot(messages: unknown): boolean {
  return JSON.stringify(messages).includes('"id":"root"');
}
