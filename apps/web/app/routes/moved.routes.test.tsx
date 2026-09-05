import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { expect, test } from "vitest";
import AdminGuardrails from "./_app.admin.guardrails";
import AdminRoles from "./_app.admin.roles";
import AdminUsers from "./_app.admin.users";
import { clientLoader as oldTeamsLoader } from "./_app.business.access.teams";
import { clientLoader as oldTeamDetailLoader } from "./_app.business.access.teams.$slug";
import { clientLoader as oldTeamCreateLoader } from "./_app.business.access.teams.new";
import BusinessPeople from "./_app.business.people";
import KnowledgeFiles from "./_app.knowledge.files";
import RunsIndex from "./_app.runs._index";
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
  ["/knowledge/files", KnowledgeFiles, "/files"],
  ["/admin/guardrails", AdminGuardrails, "/business/guardrails"],
  ["/runs", RunsIndex, "/business/activities"],
];

test.each(MOVES)("%s redirects to %s", async (from, Component, to) => {
  const Stub = createRemixStub([
    { path: from, Component },
    { path: to, Component: () => <p>arrived at {to}</p> },
  ]);
  render(<Stub initialEntries={[from]} />);

  await waitFor(() => expect(screen.getByText(`arrived at ${to}`)).toBeInTheDocument());
});

test.each([
  ["/business/access/teams", "/teams", {}, oldTeamsLoader],
  ["/business/access/teams/new", "/teams/new", {}, oldTeamCreateLoader],
  [
    "/business/access/teams/platform?section=members",
    "/teams/platform?section=members",
    { slug: "platform" },
    oldTeamDetailLoader,
  ],
] as const)("%s redirects to %s", async (from, to, params, loader) => {
  const runLoader = loader as (args: {
    request: Request;
    params: { slug?: string };
  }) => Promise<unknown>;
  const response = await runLoader({
    request: new Request(`http://localhost${from}`),
    params,
  }).catch((error: unknown) => error);

  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(302);
  expect((response as Response).headers.get("Location")).toBe(to);
});
