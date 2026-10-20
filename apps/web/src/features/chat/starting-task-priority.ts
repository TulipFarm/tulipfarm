export const primaryTaskCount = 3;

// Keep the first choices scannable; the rest stay one click away instead of competing as siblings (#1116).
export function prioritizeTasks<T>(tasks: T[], limit = primaryTaskCount) {
  return { primary: tasks.slice(0, limit), more: tasks.slice(limit) };
}
