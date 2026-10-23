import { parseKnowledgeDocument as parseSharedDocument } from '../parser.ts';

// Knowledge keeps unreadable plain text searchable from its raw text; Project uploads keep strict rejection.
export function parseKnowledgeDocument(...[input, options]: Parameters<typeof parseSharedDocument>) {
  return parseSharedDocument({ ...input, rawTextFallback: true }, options);
}
