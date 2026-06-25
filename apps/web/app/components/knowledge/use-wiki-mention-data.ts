import type { AnyExtension } from "@tiptap/core";
import {
  buildMentionExtensions,
  type MentionDataSource,
  type MentionItem,
} from "@tulipfarm/editor";
import { useEffect, useMemo, useRef } from "react";
import { listAgents } from "~/lib/agents";
import { listResourceTypes } from "~/lib/api";
import { listAllPages, listBundleDocuments } from "~/lib/knowledge-api";

/*
 * Builds the `@` (pages/agents/resources) + `#` (tags) editor extensions for the wiki page editor,
 * wired to a host data source. Lists are fetched once on mount into refs (not state) so the editor's
 * extensions never need to rebuild — the suggestion plugins read the latest ref on every keystroke
 * (mirrors the chat composer's `use-mention-data`). Same-space pages encode as a bundle-root `.md`
 * link; cross-space pages as `tf:page/<name>/<path>`; agents/resources as `tf:agent|resource/<id>`.
 */

// Platform/forge agents are internal infrastructure — never surface them in the author's @-menu.
const INTERNAL_AGENTS = new Set(["GeneralAssistant", "InformationArchitect"]);

export function useWikiMentionExtensions(bundleId: string): AnyExtension[] {
  const pages = useRef<MentionItem[]>([]);
  const agents = useRef<MentionItem[]>([]);
  const resources = useRef<MentionItem[]>([]);
  const tags = useRef<string[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [pageList, agentList, typeList, bundleDocs] = await Promise.all([
        listAllPages()
          .then((r) => r.items)
          .catch(() => []),
        listAgents().catch(() => []),
        listResourceTypes().catch(() => []),
        listBundleDocuments(bundleId)
          .then((r) => r.items)
          .catch(() => []),
      ]);
      if (!active) return;
      pages.current = pageList.map((p) =>
        p.bundleId === bundleId
          ? { label: p.title, href: `/${p.path}.md` }
          : {
              label: p.title,
              href: `tf:page/${encodeURIComponent(p.bundleName)}/${p.path}`,
              hint: p.bundleName,
            }
      );
      agents.current = agentList
        .filter((a) => !INTERNAL_AGENTS.has(a.name))
        .map((a) => ({
          label: a.label ?? a.name,
          href: `tf:agent/${a.name}`,
          hint: a.description ?? undefined,
        }));
      resources.current = typeList.map((t) => ({
        label: t.name,
        href: `tf:resource/${t.name}`,
        hint: "resource type",
      }));
      const tagSet = new Set<string>();
      for (const d of bundleDocs) for (const t of d.tags) tagSet.add(t);
      tags.current = [...tagSet].sort();
    })();
    return () => {
      active = false;
    };
  }, [bundleId]);

  // Built once: the data source closes over the refs, so the extensions are stable for the editor's
  // lifetime (rebuilding them would recreate the editor and drop content).
  return useMemo<AnyExtension[]>(() => {
    const source: MentionDataSource = {
      getPages: () => pages.current,
      getAgents: () => agents.current,
      getResources: () => resources.current,
      getTags: () => tags.current,
    };
    return buildMentionExtensions(source);
  }, []);
}
