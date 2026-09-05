import { useCallback, useEffect, useRef } from "react";
import { listAgents } from "~/lib/agents";
import { listResourceTypes } from "~/lib/api";
import { listSkills } from "~/lib/skills";
import type { MentionKind } from "./mention-config";
import type { MentionItem } from "./serialize";

/**
 * Lists live in a ref (not state) so the value updates without re-running the editor's
 * `useMemo`'d extensions — the suggestion plugin closes over `getItems`, which reads the latest
 * ref on every keystroke.
 */
export type GetItems = (kind: MentionKind) => MentionItem[];

const EMPTY: Record<MentionKind, MentionItem[]> = {
  agent: [],
  skill: [],
  resource: [],
  knowledge: [],
  file: [],
};

export function useMentionData(): GetItems {
  const dataRef = useRef<Record<MentionKind, MentionItem[]>>(EMPTY);

  useEffect(() => {
    let active = true;
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
          knowledge: [],
          file: [],
        };
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);

  return useCallback((kind: MentionKind) => dataRef.current[kind], []);
}
