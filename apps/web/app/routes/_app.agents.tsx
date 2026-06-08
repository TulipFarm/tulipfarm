import { type MetaFunction, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Agents · tulipfarm" }];

// Thin layout for the Agents subtree (index / :name). Each child owns its data.
export default function AgentsLayout() {
  return <Outlet />;
}
