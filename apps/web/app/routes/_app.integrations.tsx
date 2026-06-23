import { type MetaFunction, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

export default function IntegrationsLayout() {
  return <Outlet />;
}
