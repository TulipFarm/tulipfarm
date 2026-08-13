import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { expect, test } from "vitest";
import AdminGuardrails from "./_app.admin.guardrails";
import AdminRoles from "./_app.admin.roles";
import AdminUsers from "./_app.admin.users";
import BusinessPeople from "./_app.business.people";
import SettingsIndex from "./_app.settings._index";
import SettingsAbout from "./_app.settings.about";
import SettingsActivities from "./_app.settings.activities";
import SettingsLlm from "./_app.settings.llm";
import SettingsObservability from "./_app.settings.observability";
import SettingsSecrets from "./_app.settings.secrets";
import SettingsSecurity from "./_app.settings.security";
import SettingsSoul from "./_app.settings.soul";

/*
 * Every URL the redesign retired still resolves. A bookmark or a link in someone's notes is a
 * promise the product made; moving a page is not a reason to break it.
 */

const MOVES: [string, ComponentType, string][] = [
  ["/settings", SettingsIndex, "/settings/profile"],
  ["/settings/secrets", SettingsSecrets, "/business/secrets"],
  ["/settings/llm", SettingsLlm, "/business/models"],
  ["/settings/soul", SettingsSoul, "/business/soul"],
  ["/settings/activities", SettingsActivities, "/business/activities"],
  ["/settings/observability", SettingsObservability, "/business/observability"],
  ["/settings/about", SettingsAbout, "/business/about"],
  ["/settings/security", SettingsSecurity, "/settings/auth"],
  ["/admin/users", AdminUsers, "/business/access"],
  ["/admin/roles", AdminRoles, "/business/access"],
  ["/business/people", BusinessPeople, "/business/access"],
  ["/admin/guardrails", AdminGuardrails, "/business/guardrails"],
];

test.each(MOVES)("%s redirects to %s", async (from, Component, to) => {
  const Stub = createRemixStub([
    { path: from, Component },
    { path: to, Component: () => <p>arrived at {to}</p> },
  ]);
  render(<Stub initialEntries={[from]} />);

  await waitFor(() => expect(screen.getByText(`arrived at ${to}`)).toBeInTheDocument());
});
