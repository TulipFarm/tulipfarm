import { useCallback, useEffect, useRef } from "react";
import { listAgents } from "~/lib/agents";
import { listResourceTypes } from "~/lib/api";
import { listSkills } from "~/lib/skills";
import type { MentionKind } from "./mention-config";
import type { MentionItem } from "./serialize";

/**
 * Fetch the `@agent` / `/skill` / `#resource` menus once on mount and expose a stable `getItems(kind)`
 * reader. Lists live in a ref (not state) so the value updates without re-running the editor's
 * `useMemo`'d extensions — the suggestion plugin closes over `getItems`, which reads the latest ref on
 * every keystroke. Failures degrade to an empty menu for that kind (the composer still works).
 */
export type GetItems = (kind: MentionKind) => MentionItem[];

// `knowledge` is search-powered (server fuzzy search per keystroke), not a static list — its menu
// items come from `searchDocuments` in mentions.ts, so this static reader always returns [] for it.
const EMPTY: Record<MentionKind, MentionItem[]> = {
  agent: [],
  skill: [],
  resource: [],
  knowledge: [],
};

export function useMentionData(): GetItems {
  const dataRef = useRef<Record<MentionKind, MentionItem[]>>(EMPTY);

  useEffect(() => {
    let active = true;
    // Wrapped so any failure (network, or a partially-mocked client in tests) leaves the menus empty
    // rather than surfacing an unhandled rejection — the composer stays fully usable without them.
    void (async () => {
      try {
        const [agents, skills, types] = await Promise.all([
          listAgents().catch(() => []),
          listSkills().catch(() => []),
          listResourceTypes().catch(() => []),
        ]);
        if (!active) return;
        dataRef.current = {
          agent: agents.map((a) => ({
            id: a.name,
            label: a.label ?? a.name,
            description: a.description,
            domain: a.domain,
            autonomy: a.autonomy,
            model: a.model,
          })),
          skill: skills.map((s) => ({ id: s.name, label: s.name, description: s.description })),
          resource: types.map((t) => ({ id: t.name, label: t.name, description: "resource type" })),
          // Populated per-keystroke via server search (mentions.ts), not from this one-shot fetch.
          knowledge: [],
        };
      } catch {
        // menus unavailable — leave them empty
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return useCallback((kind: MentionKind) => dataRef.current[kind], []);
}
