import type { WorkflowDiagramNode } from '../../components/workflow-diagram.tsx';

type Lane = { children: Map<string, Lane>; x: number };

export function workflowLayout(nodes: WorkflowDiagramNode[], gates: ReadonlyMap<string, ReadonlySet<string>>) {
  const root: Lane = { children: new Map(), x: 0 };
  const lanes = new Map<string, Lane>();
  const order = new Map(nodes.map(node => [node.id, node.ordinal]));
  const requirements = (id: string) => [...(gates.get(id) ?? [])];
  const compatible = (left: string, right: string) =>
    requirements(left).every(gate => {
      const [id, choice] = gate.split(':');
      return !gates.get(right)?.has(`${id}:${choice === 'ifMet' ? 'otherwise' : 'ifMet'}`);
    });
  for (const node of nodes) {
    let lane = root;
    for (const gate of requirements(node.id).sort(
      (a, b) => order.get(a.split(':')[0]!)! - order.get(b.split(':')[0]!)!,
    )) {
      if (!lane.children.has(gate)) lane.children.set(gate, { children: new Map(), x: 0 });
      lane = lane.children.get(gate)!;
    }
    lanes.set(node.id, lane);
  }
  let nextColumn = 0;
  const place = (lane: Lane): number => {
    if (!lane.children.size) return (lane.x = nextColumn++ * 344);
    const children = [...lane.children.entries()].sort(([a], [b]) => {
      const [aId, aChoice] = a.split(':'),
        [bId, bChoice] = b.split(':');
      return order.get(aId!)! - order.get(bId!)! || (aChoice === bChoice ? 0 : aChoice === 'ifMet' ? -1 : 1);
    });
    const columns = children.map(([, child]) => place(child));
    return (lane.x = (columns[0]! + columns.at(-1)!) / 2);
  };
  place(root);

  const ranks = new Map<string, number>();
  const predecessors = new Map<string, WorkflowDiagramNode[]>();
  for (const [index, node] of nodes.entries()) {
    const earlier = nodes.slice(0, index).filter(previous => compatible(previous.id, node.id));
    // Only mutually exclusive steps share a row. Compatible work retains definition order.
    const rank = earlier.length ? Math.max(...earlier.map(previous => ranks.get(previous.id)!)) + 1 : 0;
    ranks.set(node.id, rank);
    node.position = { x: lanes.get(node.id)!.x, y: rank * 192 };
    predecessors.set(
      node.id,
      earlier.filter(
        previous => !earlier.some(next => next.ordinal > previous.ordinal && compatible(previous.id, next.id)),
      ),
    );
  }
  return predecessors;
}
