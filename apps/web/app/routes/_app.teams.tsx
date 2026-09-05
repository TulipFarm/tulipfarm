import { Outlet } from "@remix-run/react";
import { PageShell } from "~/components/page-shell";

export default function TeamsLayout() {
  return (
    <PageShell crumbs={[{ label: "Teams" }]} title="Teams">
      <Outlet />
    </PageShell>
  );
}
