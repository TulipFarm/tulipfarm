import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { IntegrationAuthFlow, startHandoff } from "~/components/integrations/auth-flow";
import type { AuthStepSummary } from "~/lib/integrations";

const connectIntegration = vi.hoisted(() => vi.fn());
const startAuthStep = vi.hoisted(() => vi.fn());

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  connectIntegration,
  startAuthStep,
}));

function fieldsStep(overrides: Partial<AuthStepSummary> = {}): AuthStepSummary {
  return {
    index: 0,
    kind: "fields",
    title: "Copy the app credentials",
    description: "All three values sit on the app's settings page.",
    satisfied: false,
    producesEnv: true,
    fields: [
      { name: "SLACK_CLIENT_ID", label: "Client ID", description: "From Basic Information." },
      { name: "SLACK_CLIENT_SECRET", label: "Client Secret", secret: true },
    ],
    ...overrides,
  };
}

function flow(steps: AuthStepSummary[], onAdvance = vi.fn()) {
  render(
    <IntegrationAuthFlow
      slug="slack"
      providerLabel="Slack"
      steps={steps}
      onAdvance={onAdvance}
      calloutError={undefined}
    />
  );
  return onAdvance;
}

beforeEach(() => {
  connectIntegration.mockReset().mockResolvedValue({ status: "connected", toolCount: 0 });
  startAuthStep.mockReset();
});

test("renders the whole declared flow so its shape is visible", () => {
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: true,
      producesEnv: true,
    },
    fieldsStep({ index: 1 }),
    {
      index: 2,
      kind: "oauth2",
      title: "Install to your workspace",
      satisfied: false,
      producesEnv: true,
    },
  ]);
  expect(screen.getByText("Create the Slack app")).toBeInTheDocument();
  expect(screen.getByText("Install to your workspace")).toBeInTheDocument();
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
});

test("marks the current step with aria-current, not tone alone", () => {
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: true,
      producesEnv: true,
    },
    fieldsStep({ index: 1 }),
  ]);
  const current = document.querySelector('[aria-current="step"]');
  expect(current).toHaveTextContent("Copy the app credentials");
});

test("reports progress to assistive tech", () => {
  flow([
    { index: 0, kind: "app_manifest", title: "Create", satisfied: true, producesEnv: true },
    fieldsStep({ index: 1 }),
  ]);
  const bar = screen.getByRole("progressbar", { name: "Setup progress" });
  expect(bar).toHaveAttribute("aria-valuenow", "1");
  expect(bar).toHaveAttribute("aria-valuemax", "2");
});

test("the first unsatisfied step is the one shown", () => {
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: true,
      producesEnv: true,
    },
    fieldsStep({ index: 1 }),
  ]);
  expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
});

test("renders nothing once every step is satisfied", () => {
  const { container } = render(
    <IntegrationAuthFlow
      slug="slack"
      providerLabel="Slack"
      steps={[fieldsStep({ satisfied: true })]}
      onAdvance={vi.fn()}
    />
  );
  expect(container).toBeEmptyDOMElement();
});

test("submits only the active step's fields, so a flow can be filled one step at a time", async () => {
  const user = userEvent.setup();
  const onAdvance = flow([
    fieldsStep(),
    {
      index: 1,
      kind: "oauth2",
      title: "Install to your workspace",
      satisfied: false,
      producesEnv: true,
    },
  ]);

  await user.type(screen.getByLabelText("Client ID"), "abc");
  await user.type(screen.getByLabelText("Client Secret"), "shh");
  await user.click(screen.getByRole("button", { name: "Save and continue" }));

  await waitFor(() => expect(connectIntegration).toHaveBeenCalled());
  expect(connectIntegration).toHaveBeenCalledWith("slack", {
    SLACK_CLIENT_ID: "abc",
    SLACK_CLIENT_SECRET: "shh",
  });
  expect(onAdvance).toHaveBeenCalled();
});

test("blocks submit on an empty field and focuses the first offender", async () => {
  const user = userEvent.setup();
  flow([fieldsStep()]);

  await user.type(screen.getByLabelText("Client Secret"), "shh");
  await user.click(screen.getByRole("button", { name: "Save and continue" }));

  expect(connectIntegration).not.toHaveBeenCalled();
  const clientId = screen.getByLabelText("Client ID");
  expect(clientId).toHaveAttribute("aria-invalid", "true");
  expect(clientId).toHaveFocus();
  expect(screen.getByText("Client ID is required.")).toBeInTheDocument();
});

test("secrets are masked and plain config is not", () => {
  flow([fieldsStep()]);
  expect(screen.getByLabelText("Client Secret")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("Client ID")).toHaveAttribute("type", "text");
});

test("surfaces an API failure instead of silently staying put", async () => {
  const user = userEvent.setup();
  connectIntegration.mockRejectedValue(new Error("missing required env: SLACK_APP_TOKEN"));
  flow([fieldsStep()]);

  await user.type(screen.getByLabelText("Client ID"), "abc");
  await user.type(screen.getByLabelText("Client Secret"), "shh");
  await user.click(screen.getByRole("button", { name: "Save and continue" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("missing required env");
});

test("shows a failure the provider reported on the way back", () => {
  flow([fieldsStep()]);
  render(
    <IntegrationAuthFlow
      slug="slack"
      providerLabel="Slack"
      steps={[fieldsStep()]}
      onAdvance={vi.fn()}
      calloutError="This setup link expired or was already used."
    />
  );
  expect(screen.getAllByRole("alert")[0]).toHaveTextContent("expired or was already used");
});

test("a redirect step navigates the browser to the provider", async () => {
  const user = userEvent.setup();
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign },
  });
  startAuthStep.mockResolvedValue({
    action: "redirect",
    url: "https://slack.com/oauth/v2/authorize?client_id=1",
  });
  flow([
    {
      index: 3,
      kind: "oauth2",
      title: "Install to your workspace",
      satisfied: false,
      producesEnv: true,
    },
  ]);

  await user.click(screen.getByRole("button", { name: /Authorize on Slack/ }));

  await waitFor(() => expect(assign).toHaveBeenCalled());
  // The step's own index must be sent, not its position in the list.
  expect(startAuthStep).toHaveBeenCalledWith("slack", 3, {});
  expect(assign).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?client_id=1");
});

test("a personal handoff starts the step with user scope", async () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign },
  });
  startAuthStep.mockResolvedValue({
    action: "redirect",
    url: "https://github.com/login/oauth/authorize?client_id=1",
  });

  await startHandoff("github", 3, false, undefined, "user");

  expect(startAuthStep).toHaveBeenCalledWith("github", 3, { scope: "user" });
  expect(assign).toHaveBeenCalled();
});

test("a form_post step POSTs the manifest, which a redirect cannot express", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(submit);
  startAuthStep.mockResolvedValue({
    action: "form_post",
    url: "https://github.com/settings/apps/new?state=xyz",
    field: "manifest",
    value: '{"name":"TulipFarm"}',
  });
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the GitHub App",
      satisfied: false,
      producesEnv: true,
    },
  ]);

  await user.click(screen.getByRole("button", { name: /Create app on Slack/ }));

  await waitFor(() => expect(submit).toHaveBeenCalled());
  const form = document.querySelector("form[method=post]") as HTMLFormElement;
  expect(form.action).toBe("https://github.com/settings/apps/new?state=xyz");
  const input = form.querySelector("input[name=manifest]") as HTMLInputElement;
  expect(input.value).toBe('{"name":"TulipFarm"}');
});

test("an org typed into the optional field is sent with the handoff", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(submit);
  startAuthStep.mockResolvedValue({
    action: "form_post",
    url: "https://github.com/organizations/acme-corp/settings/apps/new?state=xyz",
    field: "manifest",
    value: '{"name":"TulipFarm"}',
  });
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the GitHub App",
      satisfied: false,
      producesEnv: true,
      supportsOrgTarget: true,
    },
  ]);

  await user.type(screen.getByLabelText("Organization (optional)"), "acme-corp");
  await user.click(screen.getByRole("button", { name: /Create app on Slack/ }));

  await waitFor(() => expect(startAuthStep).toHaveBeenCalledWith("slack", 0, { org: "acme-corp" }));
});

test("the org field is absent when the step does not support org targeting", () => {
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: false,
      producesEnv: true,
    },
  ]);
  expect(screen.queryByLabelText("Organization (optional)")).not.toBeInTheDocument();
});

test("a handoff failure is reported and the button becomes usable again", async () => {
  const user = userEvent.setup();
  startAuthStep.mockRejectedValue(new Error("SLACK_CLIENT_ID is not set"));
  flow([
    {
      index: 1,
      kind: "oauth2",
      title: "Install to your workspace",
      satisfied: false,
      producesEnv: true,
    },
  ]);

  const button = screen.getByRole("button", { name: /Authorize on Slack/ });
  await user.click(button);

  expect(await screen.findByRole("alert")).toHaveTextContent("SLACK_CLIENT_ID is not set");
  expect(button).toBeEnabled();
});

test("falls back to a title when the manifest declares none", () => {
  flow([{ index: 0, kind: "install", satisfied: false, producesEnv: true }]);
  expect(screen.getByRole("heading", { name: "Install the app" })).toBeInTheDocument();
});

// A step that writes no connection env is `satisfied` from the moment it is declared, because
// there is nothing outstanding to look for. Treating that as "done" silently skipped Slack's
// "create the app" — the step that hands over the prefilled manifest.
test("does not skip a step just because it can never report itself finished", () => {
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: true,
      producesEnv: false,
    },
    fieldsStep({ index: 1 }),
  ]);
  expect(screen.getByRole("heading", { name: "Create the Slack app" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
});

test("an unobservable step opens beside the app and advances on the operator's word", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  vi.stubGlobal("open", open);
  startAuthStep.mockResolvedValue({ action: "redirect", url: "https://api.slack.com/apps?x=1" });
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: true,
      producesEnv: false,
    },
    fieldsStep({ index: 1 }),
  ]);

  await user.click(screen.getByRole("button", { name: /Create app on Slack/ }));

  // A new tab, not a navigation: nothing will redirect the operator back, so taking the tab would
  // strand them on the provider.
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      "https://api.slack.com/apps?x=1",
      "_blank",
      "noopener,noreferrer"
    )
  );
  expect(await screen.findByLabelText("Client ID")).toBeInTheDocument();
  vi.unstubAllGlobals();
});

test("a step the server has proven is behind us, so the flow resumes after it", () => {
  flow([
    {
      index: 0,
      kind: "app_manifest",
      title: "Create the Slack app",
      satisfied: true,
      producesEnv: false,
    },
    fieldsStep({ index: 1, satisfied: true }),
    {
      index: 2,
      kind: "oauth2",
      title: "Install to your workspace",
      satisfied: false,
      producesEnv: true,
    },
  ]);
  // Step 1 still cannot prove itself, but step 2 did — which is proof enough the operator passed it.
  expect(screen.getByRole("heading", { name: "Install to your workspace" })).toBeInTheDocument();
});
