import { type MetaFunction, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Access · Business · tulipfarm" }];

// Thin layout for the Access subtree (groups / grants / check). Each child owns its data.
export default function AccessLayout() {
  return <Outlet />;
}
