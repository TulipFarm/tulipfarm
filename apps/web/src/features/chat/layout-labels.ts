/** The label of every `{ value, label }` option the reply holds, from its components, data and lookup results. */
export function optionLabels(messages: readonly unknown[]) {
  const labels = new Map<string, string>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 12 || typeof item !== 'object' || item === null) return;
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
      return;
    }
    const { value, label } = item as Record<string, unknown>;
    if (typeof value === 'string' && typeof label === 'string' && label.trim() && !labels.has(value))
      labels.set(value, label.trim());
    for (const entry of Object.values(item)) visit(entry, depth + 1);
  };
  visit(messages, 0);
  return labels;
}

/** What the person saw for each sent value that is a chosen option, such as a deal's name for its row ID. */
export function chosenLabels(context: Record<string, unknown>, labels: ReadonlyMap<string, string>) {
  const shown: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    const chosen = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (!chosen.length || !chosen.every(item => typeof item === 'string' && labels.has(item))) continue;
    const text = chosen.map(item => labels.get(item as string)).join(', ');
    if (text.length <= 1000 && text !== chosen.join(', ')) shown[key] = text;
  }
  return Object.keys(shown).length ? shown : undefined;
}
