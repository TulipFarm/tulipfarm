import { type MetaFunction, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Skills · tulipfarm" }];

// Thin layout for the Skills subtree (index / install / :name). Each child owns its data.
export default function SkillsLayout() {
  return <Outlet />;
}
