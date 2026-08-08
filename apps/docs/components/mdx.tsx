import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { PromptBlock } from "@/components/prompt-block";
import { Screenshot } from "@/components/screenshot";

/**
 * The component vocabulary every `.mdx` page may use without an import. Keep this the single
 * registry — a page that imports a component directly drifts from the rest of the site.
 *
 * `defaultMdxComponents` already supplies Callout, Card/Cards, CodeBlockTabs, and the heading,
 * link, image, table, and `pre` overrides.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    File,
    Files,
    Folder,
    ImageZoom,
    PromptBlock,
    Screenshot,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
