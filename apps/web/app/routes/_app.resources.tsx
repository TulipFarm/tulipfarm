import { type MetaFunction, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

// Thin layout for the Resources subtree (index / :type / :type.:id). Each child owns its data.
export default function ResourcesLayout() {
  return <Outlet />;
}
