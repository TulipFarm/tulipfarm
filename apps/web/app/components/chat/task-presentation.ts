import type { Task } from "~/lib/tasks";

/** The two setup checks from the reconciler, identified by their actions, not their copy. */
export function isSetupTask(task: Task): boolean {
  if (!task.blocking) return false;
  const action = task.action;
  return (
    (action.kind === "answer" &&
      action.sink === "business_profile" &&
      action.field === "businessName") ||
    (action.kind === "link" && action.href === "/business/models")
  );
}
