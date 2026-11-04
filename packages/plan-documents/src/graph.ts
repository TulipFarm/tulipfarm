export type PlanGraphTask = {
  key: string;
  parent: string | null;
  kind: 'group' | 'work';
  title: string;
  dependsOn: readonly string[];
};

export type PlanGraphLine = { depth: number; text: string };

/** Above this many work tasks the graph shows groups only, so it stays legible on one page. */
export const planGraphWorkTaskLimit = 40;

export function mermaidNodeId(key: string): string {
  return `t_${key.replace(/[^a-z0-9]/gi, '_')}`;
}

const labelEntities: Record<string, string> = {
  '#': '#35;',
  '"': '#quot;',
  '<': '#lt;',
  '>': '#gt;',
  '&': '#amp;',
  ';': '#59;',
  '`': '#96;',
};

/** Escapes a label for a quoted Mermaid string with Mermaid's `#…;` entity codes. */
export function mermaidLabel(text: string): string {
  const escaped = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[#"<>&;`]/g, character => labelEntities[character] ?? character);
  return `"${escaped}"`;
}

function index(tasks: readonly PlanGraphTask[]) {
  const byKey = new Map(tasks.map(task => [task.key, task]));
  const children = new Map<string | null, PlanGraphTask[]>();
  for (const task of tasks) {
    const parent = task.parent !== null && byKey.has(task.parent) ? task.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const ancestors = (key: string) => {
    const seen = new Set<string>();
    for (let parent = byKey.get(key)?.parent ?? null; parent !== null && byKey.has(parent) && !seen.has(parent);) {
      seen.add(parent);
      parent = byKey.get(parent)?.parent ?? null;
    }
    return seen;
  };
  return { byKey, children, ancestors };
}

function edgeLines(edges: Iterable<[string, string]>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [from, to] of edges) {
    const line = `  ${mermaidNodeId(from)} --> ${mermaidNodeId(to)}`;
    if (from === to || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/**
 * Mermaid `flowchart TD` source for a plan: groups become subgraphs, work tasks nodes, and each dependency an edge from
 * the task waited for. With more than {@link planGraphWorkTaskLimit} work tasks it collapses to top-level groups.
 */
export function planGraphMermaid(tasks: readonly PlanGraphTask[]): string {
  const { byKey, children, ancestors } = index(tasks);
  const work = tasks.filter(task => task.kind === 'work');
  const lines = ['flowchart TD'];
  if (work.length > planGraphWorkTaskLimit) {
    const unit = (key: string) => {
      return [key, ...ancestors(key)].at(-1) ?? key;
    };
    const units = children.get(null) ?? [];
    for (const task of units) {
      const count =
        task.kind === 'group' ? tasks.filter(item => unit(item.key) === task.key && item.kind === 'work') : [];
      const label =
        task.kind === 'group' ? `${task.title} (${count.length} ${count.length === 1 ? 'task' : 'tasks'})` : task.title;
      lines.push(`  ${mermaidNodeId(task.key)}[${mermaidLabel(label)}]`);
    }
    const edges: [string, string][] = [];
    for (const task of tasks)
      for (const dependency of task.dependsOn)
        if (byKey.has(dependency)) edges.push([unit(dependency), unit(task.key)]);
    return [...lines, ...edgeLines(edges)].join('\n');
  }
  const emit = (parent: string | null, depth: number) => {
    const pad = '  '.repeat(depth);
    for (const task of children.get(parent) ?? []) {
      if (task.kind === 'group') {
        lines.push(`${pad}subgraph ${mermaidNodeId(task.key)}[${mermaidLabel(task.title)}]`);
        emit(task.key, depth + 1);
        lines.push(`${pad}end`);
      } else lines.push(`${pad}${mermaidNodeId(task.key)}[${mermaidLabel(task.title)}]`);
    }
  };
  emit(null, 1);
  const edges: [string, string][] = [];
  for (const task of tasks)
    for (const dependency of task.dependsOn) {
      // Mermaid cannot draw an edge between a subgraph and anything inside it.
      if (!byKey.has(dependency) || ancestors(task.key).has(dependency) || ancestors(dependency).has(task.key))
        continue;
      edges.push([dependency, task.key]);
    }
  return [...lines, ...edgeLines(edges)].join('\n');
}

/** The plan graph as an indented outline, for readers who cannot see the drawing. */
export function planGraphOutline(tasks: readonly PlanGraphTask[]): PlanGraphLine[] {
  const { byKey, children } = index(tasks);
  const lines: PlanGraphLine[] = [];
  const emit = (parent: string | null, depth: number) => {
    for (const task of children.get(parent) ?? []) {
      const waits = task.dependsOn.flatMap(key => {
        const dependency = byKey.get(key);
        return dependency ? [dependency.title] : [];
      });
      const label = task.kind === 'group' ? `Group: ${task.title}` : task.title;
      lines.push({ depth, text: waits.length ? `${label} (waits for ${waits.join(', ')})` : label });
      if (task.kind === 'group') emit(task.key, depth + 1);
    }
  };
  emit(null, 0);
  return lines;
}

export function planGraphText(tasks: readonly PlanGraphTask[]): string {
  return planGraphOutline(tasks)
    .map(line => `${'  '.repeat(line.depth)}- ${line.text}`)
    .join('\n');
}
