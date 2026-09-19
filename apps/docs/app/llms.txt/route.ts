import { llms } from "fumadocs-core/source";
import { absoluteDocsLinks, DOCS_URL } from "@/lib/shared";
import { source } from "@/lib/source";

export const revalidate = false;

export function GET() {
  const index = absoluteDocsLinks(llms(source).index());
  return new Response(`${index}\n\nFull text: ${DOCS_URL}/llms-full.txt\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
