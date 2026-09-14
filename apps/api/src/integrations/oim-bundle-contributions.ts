import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compileOimCompositeOperations,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
} from "@tulipfarm/integrations";
import type { BundleCompileContribution } from "@tulipfarm/soul";
import { loadBundledOimCatalog } from "./oim-catalog";

export function createBundledOimBundleContributionProvider(
  root: string
): () => Promise<readonly BundleCompileContribution[]> {
  return async () => {
    const entries = await loadBundledOimCatalog(root, { requireVerification: true });
    const documents = entries
      .flatMap((entry) => [
        ...compileOimHttpOperations(entry.manifest, {}, { deferConfiguration: true }),
        ...compileOimGraphqlOperations(
          entry.manifest,
          new Map(Object.entries(entry.integration.oimDocuments ?? {})),
          {},
          { deferConfiguration: true }
        ),
        ...compileOimOpenApiOperations(
          entry.manifest,
          new Map(Object.entries(entry.integration.oimOpenApiDocuments ?? {})),
          {},
          { deferConfiguration: true }
        ),
        ...compileOimCompositeOperations(
          entry.manifest,
          new Map(Object.entries(entry.integration.oimDocuments ?? {})),
          new Map(Object.entries(entry.integration.oimOpenApiDocuments ?? {})),
          {},
          { deferConfiguration: true }
        ),
      ])
      .map(({ contract }) => contract);
    const files = (
      await Promise.all(
        entries.map(async (entry) => {
          const directory = join(root, entry.key);
          return [
            {
              path: `integrations/${entry.key}/oim.yml`,
              content: await readFile(join(directory, "oim.yml"), "utf8"),
            },
            ...Object.entries(entry.integration.oimPackageFiles ?? {}).map(([path, content]) => {
              if (typeof content !== "string") {
                throw new Error(`bundled OIM companion ${entry.key}/${path} is not UTF-8 text`);
              }
              return {
                path: `integrations/${entry.key}/${path}`,
                content,
              };
            }),
          ];
        })
      )
    ).flat();
    return [{ source: "bundled OIM packages", documents, files }];
  };
}
