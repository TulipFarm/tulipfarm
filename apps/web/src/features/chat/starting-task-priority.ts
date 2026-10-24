export const primaryTaskCount = 3;

// Keep the first choices scannable; the rest stay one click away instead of competing as siblings (#1116).
// A short saved list is topped up with general prompts so the first screen never offers a lone choice.
export function fillTasks<T extends { id: string; label: string }>(
  saved: T[],
  general: T[],
  minimum = primaryTaskCount,
) {
  const extra = general.filter(task => !saved.some(item => item.id === task.id || item.label === task.label));
  return [...saved, ...extra.slice(0, Math.max(0, minimum - saved.length))];
}

export function prioritizeTasks<T>(tasks: T[], limit = primaryTaskCount) {
  return { primary: tasks.slice(0, limit), more: tasks.slice(limit) };
}
