import { type MetaFunction, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Routines · tulipfarm" }];

export default function RoutinesLayout() {
  return <Outlet />;
}
