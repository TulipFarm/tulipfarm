import type { AnyExtension } from "@tiptap/core";
import {
  buildMentionExtensions,
  type MentionDataSource,
  type MentionItem,
} from "@tulipfarm/editor";
import { useEffect, useMemo, useRef } from "react";
import { listAgents } from "~/lib/agents";
import { listResourceTypes } from "~/lib/api";
import { listAllPages, listSpacePages } from "~/lib/knowledge-api";

/*
 * Lists are fetched once on mount into refs (not state) so the editor's extensions never need
 * to rebuild — the suggestion plugins read the latest ref on every keystroke (mirrors the chat
 * composer's `use-mention-data`).
 */

const INTERNAL_AGENTS = new Set<string>();

export function useWikiMentionExtensions(spaceId: string): AnyExtension[] {
  const pages = useRef<MentionItem[]>([]);
  const agents = useRef<MentionItem[]>([]);
  const resources = useRef<MentionItem[]>([]);
  const tags = useRef<string[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [pageList, agentList, typeList, spacePages] = await Promise.all([
        listAllPages()
          .then((r) => r.items)
          .catch(() => []),
        listAgents().catch(() => []),
        listResourceTypes().catch(() => []),
        listSpacePages(spaceId)
          .then((r) => r.items)
          .catch(() => []),
      ]);
      if (!active) return;
      pages.current = pageList.map((p) =>
        p.spaceId === spaceId
          ? { label: p.title, href: `/${p.path}.md` }
          : {
              label: p.title,
              href: `tf:page/${encodeURIComponent(p.spaceName)}/${p.path}`,
              hint: p.spaceName,
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
      for (const d of spacePages) for (const t of d.tags) tagSet.add(t);
      tags.current = [...tagSet].sort();
    })();
    return () => {
      active = false;
    };
  }, [spaceId]);

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
