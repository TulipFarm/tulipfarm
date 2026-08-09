import type { EmittedPrincipalRef, KnowledgeIdentityMapPort } from "./source";

export interface MapExternalPrincipalsInput {
  readonly subjects: readonly string[];
  readonly identity: KnowledgeIdentityMapPort;
  readonly businessId: string;
  readonly provider: string;
}

export async function mapExternalPrincipals(
  input: MapExternalPrincipalsInput
): Promise<EmittedPrincipalRef[]> {
  const principals: EmittedPrincipalRef[] = [];
  const seen = new Set<string>();
  for (const subject of input.subjects) {
    const resolved = await input.identity.resolve({
      businessId: input.businessId,
      provider: input.provider,
      externalSubject: subject,
    });
    for (const principal of resolved ?? []) {
      const key = `${principal.kind}:${principal.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      principals.push(principal);
    }
  }
  return principals;
}

export function splitTextChunks(
  title: string,
  text: string,
  maxChunkChars = 1_800
): readonly string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let current = title.trim();
  for (const paragraph of normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChunkChars) {
      current = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += maxChunkChars) {
      chunks.push(paragraph.slice(index, index + maxChunkChars));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}
