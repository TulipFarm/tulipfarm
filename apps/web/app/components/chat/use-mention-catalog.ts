import { useEffect, useMemo, useState } from "react";
import type { Autonomy } from "~/lib/agents";
import { listAgents } from "~/lib/agents";
import { listResourceTypes } from "~/lib/api";
import { listAllPages } from "~/lib/knowledge-api";
import { listSkills } from "~/lib/skills";
import type { MentionKind } from "./editor/mention-config";

/* Mention catalog fetch failures degrade per kind to empty chips, not failed rendering. */
export interface MentionEntry {
  kind: MentionKind;
  /** The literal text the composer serialized for this mention (the highlight key). */
  phrase: string;
  id: string;
  label: string;
  description?: string;
  domain?: string;
  autonomy?: Autonomy;
  // Agent-only: the agent's configured selector (raw `frontmatter.model`); lets ChatPanel reflect
  // the active agent's effort preset in the composer.
  model?: string;
}

export interface MentionCatalog {
  entries: MentionEntry[];
  /** Agent entries keyed by name — reused for the active-agent header glyph/label. */
  agentByName: Map<string, MentionEntry>;
}

export function useMentionCatalog(): MentionCatalog {
  const [entries, setEntries] = useState<MentionEntry[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      listAgents().catch(() => []),
      listSkills().catch(() => []),
      listResourceTypes().catch(() => []),
      listAllPages().catch(() => ({ items: [] })),
    ]).then(([agents, skills, types, pages]) => {
      if (!active) return;
      const out: MentionEntry[] = [];
      for (const a of agents) {
        const label = a.label ?? a.name;
        const meta = {
          kind: "agent" as const,
          id: a.name,
          label,
          description: a.description,
          domain: a.domain,
          autonomy: a.autonomy,
          model: a.model,
        };
        out.push({ ...meta, phrase: `@${label}` });
        if (label !== a.name) out.push({ ...meta, phrase: `@${a.name}` });
      }
      for (const s of skills) {
        out.push({
          kind: "skill",
          phrase: `/${s.name}`,
          id: s.name,
          label: s.name,
          description: s.description,
        });
      }
      for (const t of types) {
        out.push({ kind: "resource", phrase: `#${t.name}`, id: t.name, label: t.name });
      }
      for (const pg of pages.items) {
        if (!pg.title) continue; // a blank title would make a bare `~` phrase that matches everything
        out.push({
          kind: "knowledge",
          phrase: `~${pg.title}`,
          id: pg.pageId,
          label: pg.title,
          description: `${pg.spaceName} · ${pg.path}`,
        });
      }
      setEntries(out);
    });
    return () => {
      active = false;
    };
  }, []);

  const agentByName = useMemo(() => {
    const map = new Map<string, MentionEntry>();
    for (const entry of entries) {
      if (entry.kind === "agent" && !map.has(entry.id)) map.set(entry.id, entry);
    }
    return map;
  }, [entries]);

  return { entries, agentByName };
}
