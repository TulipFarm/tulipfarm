import { llms } from "fumadocs-core/source";
import { DOCS_URL } from "@/lib/shared";
import { source } from "@/lib/source";

export const revalidate = false;

export function GET() {
  const index = llms(source).index().replaceAll("](/docs", `](${DOCS_URL}/docs`);
  return new Response(`${index}\n\nFull text: ${DOCS_URL}/llms-full.txt\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
