import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { inspectOimReleaseSource, installOimRelease } from "~/lib/integrations";
import { OimReleaseInstallDialog } from "./oim-release-install-dialog";

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  inspectOimReleaseSource: vi.fn(),
  installOimRelease: vi.fn(),
}));

const digest = "a".repeat(64);
const inspection = {
  source: "https://example.test/releases.git",
  ref: "commit-a1b2c3",
  candidates: [
    {
      sourcePath: "packages/weather",
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: digest,
      issues: [],
      review: {
        name: "Weather",
        description: "Reads forecasts and updates alerts.",
        auth: {
          credentialLabels: ["API token"],
          configurationLabels: ["Region"],
          steps: [{ title: "Connect account", type: "oauth2" }],
        },
        operations: [
          {
            name: "Read forecast",
            description: "Reads the current forecast.",
            effect: "read",
            destination: "https://api.weather.test",
          },
          {
            name: "Update alert",
            description: "Changes a weather alert.",
            effect: "write",
            destination: "https://api.weather.test",
          },
        ],
        ingress: { events: true, polling: false, knowledge: true },
      },
    },
  ],
} as const;

beforeEach(() => {
  vi.mocked(inspectOimReleaseSource).mockReset();
  vi.mocked(installOimRelease).mockReset();
});

test("reviews capabilities, destinations, auth, and exact Community bytes before install", async () => {
  vi.mocked(inspectOimReleaseSource).mockResolvedValue(inspection);
  vi.mocked(installOimRelease).mockResolvedValue({
    integrationId: "weather",
    majorVersion: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    version: "1.2.3",
    packageDigest: digest,
    trustClass: "community",
    revision: "soul-a1b2c3",
  });
  const user = userEvent.setup();

  render(<OimReleaseInstallDialog open onClose={vi.fn()} onInstalled={vi.fn()} />);
  await user.type(screen.getByLabelText("Package source"), inspection.source);
  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(await screen.findByText("Reads forecasts and updates alerts.")).toBeInTheDocument();
  expect(screen.getAllByText("Destination: https://api.weather.test")).toHaveLength(2);
  expect(screen.getByText(/Connect account \(oauth2\)/)).toBeInTheDocument();
  expect(screen.getByText(/events, Knowledge sync/)).toBeInTheDocument();

  await user.click(screen.getByLabelText("Install as a reviewed Community package"));
  await user.click(
    screen.getByLabelText(
      "I approve the capabilities, destinations, effects, and exact digest shown above."
    )
  );
  await user.click(screen.getByRole("button", { name: "Install" }));

  await waitFor(() =>
    expect(installOimRelease).toHaveBeenCalledWith({
      source: inspection.source,
      sourceRef: inspection.ref,
      slug: "weather",
      selection: { integrationId: "weather", version: "1.2.3", packageDigest: digest },
      trustClass: "community",
      approvedCommunityDigest: digest,
      autoPatchOptIn: false,
    })
  );
});

test("retries the frozen reviewed package and ignores a late stale inspection", async () => {
  let resolveFirst: (value: typeof inspection) => void = () => {};
  vi.mocked(inspectOimReleaseSource)
    .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
    .mockResolvedValueOnce({
      ...inspection,
      source: "https://example.test/new.git",
      ref: "commit-new",
    });
  vi.mocked(installOimRelease)
    .mockRejectedValueOnce(new Error("Provider unavailable"))
    .mockResolvedValueOnce({
      integrationId: "weather",
      majorVersion: 1,
      installationId: "11111111-1111-4111-8111-111111111111",
      version: "1.2.3",
      packageDigest: digest,
      trustClass: "official",
      revision: "soul-a1b2c3",
    });
  const user = userEvent.setup();

  render(<OimReleaseInstallDialog open onClose={vi.fn()} onInstalled={vi.fn()} />);
  const source = screen.getByLabelText("Package source");
  await user.type(source, inspection.source);
  await user.click(screen.getByRole("button", { name: "Inspect source" }));
  await user.clear(source);
  await user.type(source, "https://example.test/new.git");
  resolveFirst(inspection);
  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(await screen.findByText(/Reviewed ref commit-new/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Install" }));
  expect(await screen.findByRole("button", { name: "Retry same package" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry same package" }));

  expect(installOimRelease).toHaveBeenCalledTimes(2);
  expect(vi.mocked(installOimRelease).mock.calls[1]).toEqual(
    vi.mocked(installOimRelease).mock.calls[0]
  );
  expect(screen.getByRole("status")).toHaveTextContent("Official package verified and installed.");
});

test("blocks installation when detailed review is unavailable", async () => {
  vi.mocked(inspectOimReleaseSource).mockResolvedValue({
    ...inspection,
    candidates: [{ ...inspection.candidates[0], review: undefined }],
  });
  const user = userEvent.setup();

  render(<OimReleaseInstallDialog open onClose={vi.fn()} onInstalled={vi.fn()} />);
  await user.type(screen.getByLabelText("Package source"), inspection.source);
  await user.click(screen.getByRole("button", { name: "Inspect source" }));

  expect(await screen.findByText(/Detailed package review is unavailable/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  expect(installOimRelease).not.toHaveBeenCalled();
});

test("locks review and dismissal while an installation mutation is in flight", async () => {
  let resolveInstall: (value: Awaited<ReturnType<typeof installOimRelease>>) => void = () => {};
  vi.mocked(inspectOimReleaseSource).mockResolvedValue(inspection);
  vi.mocked(installOimRelease).mockReturnValue(
    new Promise((resolve) => {
      resolveInstall = resolve;
    })
  );
  const onClose = vi.fn();
  const onInstalled = vi.fn();
  const user = userEvent.setup();

  render(<OimReleaseInstallDialog open onClose={onClose} onInstalled={onInstalled} />);
  await user.type(screen.getByLabelText("Package source"), inspection.source);
  await user.click(screen.getByRole("button", { name: "Inspect source" }));
  await screen.findByText("Reads forecasts and updates alerts.");
  await user.click(screen.getByRole("button", { name: "Install" }));

  expect(screen.getByLabelText("Package source")).toBeDisabled();
  expect(
    screen.getByLabelText("Verify as Official on the server before installation")
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  const dialog = screen.getByRole("dialog");
  expect(dialog.dispatchEvent(new Event("cancel", { cancelable: true }))).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  expect(installOimRelease).toHaveBeenCalledTimes(1);

  resolveInstall({
    integrationId: "weather",
    majorVersion: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    version: "1.2.3",
    packageDigest: digest,
    trustClass: "official",
    revision: "soul-a1b2c3",
  });
  await waitFor(() => expect(onInstalled).toHaveBeenCalledWith("weather"));
});
