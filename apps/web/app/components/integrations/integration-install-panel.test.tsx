import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as integrations from "~/lib/integrations";
import {
  IntegrationInstallPanel,
  type IntegrationReviewRequest,
} from "./integration-install-panel";

vi.mock("~/lib/integrations", async () => {
  const actual = await vi.importActual<typeof import("~/lib/integrations")>("~/lib/integrations");
  return {
    ...actual,
    inspectIntegrationSource: vi.fn(),
    installIntegration: vi.fn(),
    updateIntegration: vi.fn(),
    getIntegration: vi.fn(),
  };
});

const inspection: integrations.InspectResult = {
  source: "https://downloads.example.com/oim.yml",
  sourceType: "https",
  ref: "0123456789abcdef",
  integrations: [
    {
      name: "helpdesk",
      majorVersion: 2,
      version: "2.0.0",
      installed: false,
      installable: true,
      issues: [],
      definition: "oim",
      support: "community",
      hooksAllowed: false,
      autoPatchEligible: false,
      license: "MIT",
      packageDigest: "sha256:reviewed-package",
      fixtures: [{ name: "lists tickets", fixture: "fixtures.yml", passed: true }],
      review: {
        integrationId: "helpdesk",
        version: "2.0.0",
        packageDigest: "sha256:reviewed-package",
        destinations: ["https://api.helpdesk.example"],
        allowedOriginHosts: ["api.helpdesk.example"],
        credentialSlots: [{ id: "token", label: "API token", kind: "api_key" }],
        operations: [
          {
            id: "ticket.create",
            name: "Create ticket",
            effect: "write",
            destination: "https://api.helpdesk.example",
          },
        ],
      },
    },
  ],
};

beforeEach(() => {
  vi.mocked(integrations.inspectIntegrationSource).mockReset().mockResolvedValue(inspection);
  vi.mocked(integrations.installIntegration).mockReset().mockResolvedValue({
    name: "helpdesk",
    source: inspection.source,
    ref: inspection.ref,
  });
  vi.mocked(integrations.updateIntegration).mockReset().mockResolvedValue({
    name: "helpdesk",
    source: inspection.source,
    ref: inspection.ref,
  });
});

function renderPanel(request: IntegrationReviewRequest) {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  render(<IntegrationInstallPanel request={request} onClose={onClose} onComplete={onComplete} />);
  return { onClose, onComplete };
}

test("reviews the exact digest, authority, and fixtures before install", async () => {
  const user = userEvent.setup();
  const enteredSource = "https://downloads.example.com/oim.yml?expires=123&signature=test-value";
  const { onComplete } = renderPanel({
    kind: "install",
    source: enteredSource,
    name: "helpdesk",
  });

  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(integrations.inspectIntegrationSource).toHaveBeenCalledWith(enteredSource);
  expect(screen.getByLabelText(/^Git or HTTPS source/)).toHaveValue(enteredSource);
  expect(await screen.findByText(inspection.source)).toBeInTheDocument();
  expect(await screen.findByText("sha256:reviewed-package")).toBeInTheDocument();
  expect(screen.getByText("Create ticket · write")).toBeInTheDocument();
  expect(screen.getByText("Community digest review")).toBeInTheDocument();
  expect(
    screen.getByText("Automatic patch updates are unavailable for this package.")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: /Install verified patch updates automatically/ })
  ).not.toBeInTheDocument();
  expect(screen.getByText("2", { selector: "dd" })).toBeInTheDocument();
  expect(screen.getByText("API token · api_key")).toBeInTheDocument();
  expect(screen.getByText("lists tickets")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Approve this digest and install" }));
  await waitFor(() =>
    expect(integrations.installIntegration).toHaveBeenCalledWith(enteredSource, "helpdesk", {
      ref: inspection.ref,
      digest: "sha256:reviewed-package",
    })
  );
  expect(onComplete).toHaveBeenCalled();
});

test("retains and sends a publisher-signed Official release without digest approval", async () => {
  const user = userEvent.setup();
  const signedRelease = {
    envelopeVersion: 1,
    release: { integrationId: "helpdesk", version: "2.0.0" },
    signature: "test-signature",
  };
  vi.mocked(integrations.inspectIntegrationSource).mockResolvedValueOnce({
    ...inspection,
    integrations: inspection.integrations.map((integration) => ({
      ...integration,
      support: "official",
      hooksAllowed: true,
      autoPatchEligible: true,
      verifiedSignerKeyId: "publisher-2026",
      revocationSequence: 9,
    })),
  });
  renderPanel({
    kind: "install",
    source: "https://downloads.example.com/oim.yml?expires=123",
    name: "helpdesk",
  });

  fireEvent.change(screen.getByLabelText(/^Signed release envelope/), {
    target: { value: JSON.stringify(signedRelease) },
  });
  await user.click(screen.getByRole("button", { name: "Inspect source" }));
  expect(integrations.inspectIntegrationSource).toHaveBeenCalledWith(
    "https://downloads.example.com/oim.yml?expires=123",
    signedRelease
  );
  expect(screen.getByText("Official signature verified")).toBeInTheDocument();
  expect(screen.getByText("publisher-2026")).toBeInTheDocument();
  expect(screen.getByText("Checked at sequence 9")).toBeInTheDocument();
  expect(screen.getByText("Allowed by verified release trust")).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: /Install verified patch updates automatically/ })
  ).toBeChecked();
  expect(
    screen.getByText(/Enabled by default. Only releases verified by an active trusted key/)
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Verify release and install" }));
  await waitFor(() =>
    expect(integrations.installIntegration).toHaveBeenCalledWith(
      "https://downloads.example.com/oim.yml?expires=123",
      "helpdesk",
      { ref: inspection.ref, signedRelease, autoPatchOptIn: true }
    )
  );
});

test("sends an explicit false when an Official install opts out of automatic patches", async () => {
  const user = userEvent.setup();
  const signedRelease = { envelopeVersion: 1, signature: "test-signature" };
  vi.mocked(integrations.inspectIntegrationSource).mockResolvedValueOnce({
    ...inspection,
    integrations: inspection.integrations.map((integration) => ({
      ...integration,
      support: "official",
      hooksAllowed: true,
      autoPatchEligible: true,
    })),
  });
  renderPanel({ kind: "install", source: inspection.source, name: "helpdesk" });

  fireEvent.change(screen.getByLabelText(/^Signed release envelope/), {
    target: { value: JSON.stringify(signedRelease) },
  });
  await user.click(screen.getByRole("button", { name: "Inspect source" }));
  await user.click(
    screen.getByRole("checkbox", { name: /Install verified patch updates automatically/ })
  );
  await user.click(screen.getByRole("button", { name: "Verify release and install" }));

  await waitFor(() =>
    expect(integrations.installIntegration).toHaveBeenCalledWith(inspection.source, "helpdesk", {
      ref: inspection.ref,
      signedRelease,
      autoPatchOptIn: false,
    })
  );
});

test("preserves an installed Official release's saved automatic patch preference", async () => {
  const user = userEvent.setup();
  const signedRelease = { envelopeVersion: 1, signature: "test-signature" };
  vi.mocked(integrations.inspectIntegrationSource).mockResolvedValueOnce({
    ...inspection,
    integrations: inspection.integrations.map((integration) => ({
      ...integration,
      installed: true,
      installedSlug: "helpdesk",
      support: "official",
      hooksAllowed: true,
      autoPatchEligible: true,
    })),
  });
  renderPanel({
    kind: "update",
    name: "helpdesk",
    source: inspection.source,
    current: {
      name: "helpdesk",
      type: "oim",
      installed: true,
      status: "connected",
      connected: true,
      version: "1.0.0",
      grants: [],
      manifest: {},
      auth: [],
    },
  });

  fireEvent.change(screen.getByLabelText(/^Signed release envelope/), {
    target: { value: JSON.stringify(signedRelease) },
  });
  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(
    screen.queryByRole("checkbox", { name: /Install verified patch updates automatically/ })
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("The existing automatic patch setting will be preserved.")
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Verify release and update" }));

  await waitFor(() =>
    expect(integrations.updateIntegration).toHaveBeenCalledWith("helpdesk", inspection.source, {
      ref: inspection.ref,
      signedRelease,
    })
  );
});

test("shows source version and changed permissions before update", async () => {
  const user = userEvent.setup();
  const enteredSource = "https://downloads.example.com/oim.yml?expires=123&signature=test-value";
  renderPanel({
    kind: "update",
    name: "helpdesk",
    source: enteredSource,
    current: {
      name: "helpdesk",
      type: "oim",
      installed: true,
      status: "connected",
      connected: true,
      version: "1.0.0",
      grants: [{ label: "List tickets", access: "read" }],
      manifest: {},
      auth: [],
    },
  });
  vi.mocked(integrations.inspectIntegrationSource).mockResolvedValueOnce({
    ...inspection,
    integrations: inspection.integrations.map((integration) => ({
      ...integration,
      installed: true,
      installedSlug: "helpdesk",
    })),
  });

  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(await screen.findByText("1.0.0 → 2.0.0")).toBeInTheDocument();
  expect(screen.getByText("+ Create ticket · write")).toBeInTheDocument();
  expect(screen.getByText("− List tickets · read")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Approve this digest and update" }));
  await waitFor(() =>
    expect(integrations.updateIntegration).toHaveBeenCalledWith("helpdesk", enteredSource, {
      ref: inspection.ref,
      digest: "sha256:reviewed-package",
    })
  );
});

test("treats an installed exact major as an update while using the install endpoint", async () => {
  const user = userEvent.setup();
  vi.mocked(integrations.inspectIntegrationSource).mockResolvedValueOnce({
    ...inspection,
    integrations: inspection.integrations.map((integration) => ({
      ...integration,
      installed: true,
      installedSlug: "helpdesk-v2",
    })),
  });
  renderPanel({
    kind: "install",
    source: inspection.source,
    name: "helpdesk-v2",
  });

  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(screen.getByRole("heading", { name: "Review integration update" })).toBeInTheDocument();
  expect(screen.getByText("helpdesk-v2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Approve this digest and update" }));
  await waitFor(() =>
    expect(integrations.installIntegration).toHaveBeenCalledWith(inspection.source, "helpdesk", {
      ref: inspection.ref,
      digest: "sha256:reviewed-package",
    })
  );
});
