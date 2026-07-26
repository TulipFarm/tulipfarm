import { useLoaderData } from "@remix-run/react";
import { RoleChangesetForm } from "~/components/admin/role-changeset-form";
import { getRoles, proposeRole } from "~/lib/admin";

export async function clientLoader() {
  return { model: await getRoles() };
}

export default function RoleAdminRoute() {
  const { model } = useLoaderData<typeof clientLoader>();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-semibold">Roles</h1>
        <p className="text-xs text-muted-foreground">
          Revision {model.revision}. Role changes use governed Soul changesets.
        </p>
      </header>
      <RoleChangesetForm
        onPropose={async (role) => {
          await proposeRole(model, role);
        }}
      />
      <ul className="divide-y divide-border border border-border bg-card">
        {model.items.map((role) => (
          <li key={role.id} className="grid gap-2 px-3 py-3 text-xs sm:grid-cols-3">
            <strong>{role.name}</strong>
            <span>{role.principalKinds.join(", ")}</span>
            <span className="text-muted-foreground">{role.grants.join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
