import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import * as trust from "~/lib/oim-release-trust";
import IntegrationsLayout from "./_app.integrations";
import OimReleaseTrustPage, {
  ErrorBoundary as ReleaseTrustErrorBoundary,
} from "./_app.integrations.release-trust";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
  };
});

vi.mock("~/lib/page-chrome-context", async () => {
  const actual = await vi.importActual<typeof import("~/lib/page-chrome-context")>(
    "~/lib/page-chrome-context"
  );
  return { ...actual, usePublishPageTitle: vi.fn() };
});

vi.mock("~/lib/use-session-user", () => ({
  useIsAdmin: () => false,
}));

vi.mock("~/lib/oim-release-trust", async () => {
  const actual =
    await vi.importActual<typeof import("~/lib/oim-release-trust")>("~/lib/oim-release-trust");
  return {
    ...actual,
    listOimTrustRoots: vi.fn(),
    addOimTrustRoot: vi.fn(),
    disableOimTrustRoot: vi.fn(),
    getOimRevocationFeed: vi.fn(),
    setOimRevocationFeed: vi.fn(),
    disableOimRevocationFeed: vi.fn(),
    importOimRevocations: vi.fn(),
  };
});

const publicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAexample=\n-----END PUBLIC KEY-----";
const root: trust.OimTrustRoot = {
  purpose: "release",
  keyId: "releases-2026",
  publicKeyPem: publicKey,
  createdAt: "2026-09-07T06:00:00.000Z",
  createdBy: "admin-1",
};

beforeEach(() => {
  vi.mocked(remix.useLoaderData).mockReturnValue({ roots: [root], feed: null });
  vi.mocked(trust.listOimTrustRoots).mockResolvedValue([root]);
  vi.mocked(trust.addOimTrustRoot).mockResolvedValue(root);
  vi.mocked(trust.disableOimTrustRoot).mockResolvedValue({
    ...root,
    disabledAt: "2026-09-07T07:00:00.000Z",
    disabledBy: "admin-1",
  });
  vi.mocked(trust.setOimRevocationFeed).mockResolvedValue({
    url: "https://updates.example.com/oim/releases.json",
    updatedAt: "2026-09-07T06:00:00.000Z",
    updatedBy: "admin-1",
  });
  vi.mocked(trust.disableOimRevocationFeed).mockResolvedValue(undefined);
  vi.mocked(trust.importOimRevocations).mockResolvedValue({
    sequence: 4,
    expiresAt: "2026-09-08T06:00:00.000Z",
  });
});

test("links operators to the separately authorized release trust surface", async () => {
  const Stub = createRemixStub([
    {
      path: "/integrations",
      Component: IntegrationsLayout,
      children: [{ index: true, Component: () => <p>Integration catalog</p> }],
    },
  ]);
  render(<Stub initialEntries={["/integrations"]} />);

  expect(await screen.findByRole("link", { name: "Release trust" })).toHaveAttribute(
    "href",
    "/integrations/release-trust"
  );
});

test("shows the distinct trust permission denial", () => {
  vi.mocked(remix.useRouteError).mockReturnValue(
    new ApiError(403, "missing deployment.oim_trust.manage")
  );
  render(<ReleaseTrustErrorBoundary />);

  expect(
    screen.getByText(/You do not have permission to manage release trust/)
  ).toBeInTheDocument();
});

test("shows only explicit public trust and refuses a private key locally", async () => {
  const user = userEvent.setup();
  render(<OimReleaseTrustPage />);

  expect(screen.getByText("releases-2026")).toBeInTheDocument();
  expect(
    screen.getByText(
      (_, element) => element?.tagName === "PRE" && element.textContent === publicKey
    )
  ).toBeInTheDocument();

  await user.type(screen.getByLabelText(/^Key ID/), "unsafe");
  await user.type(
    screen.getByLabelText(/^Public key/),
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
  );
  await user.click(screen.getByRole("button", { name: "Add trusted public key" }));

  expect(screen.getByText(/Private keys must never leave/)).toBeInTheDocument();
  expect(trust.addOimTrustRoot).not.toHaveBeenCalled();
  expect(screen.getByLabelText(/^Public key/)).toHaveFocus();
});

test("adds and disables an explicit revocation public key", async () => {
  const user = userEvent.setup();
  const revocationRoot: trust.OimTrustRoot = {
    ...root,
    purpose: "revocation",
    keyId: "revocations-2026",
  };
  vi.mocked(trust.addOimTrustRoot).mockResolvedValueOnce(revocationRoot);
  vi.mocked(trust.disableOimTrustRoot).mockResolvedValueOnce({
    ...revocationRoot,
    disabledAt: "2026-09-07T07:00:00.000Z",
    disabledBy: "admin-1",
  });
  render(<OimReleaseTrustPage />);

  await user.click(screen.getByRole("radio", { name: "Revocation signing" }));
  await user.type(screen.getByLabelText(/^Key ID/), "revocations-2026");
  await user.type(screen.getByLabelText(/^Public key/), publicKey);
  await user.click(screen.getByRole("button", { name: "Add trusted public key" }));

  await waitFor(() =>
    expect(trust.addOimTrustRoot).toHaveBeenCalledWith({
      purpose: "revocation",
      keyId: "revocations-2026",
      publicKeyPem: publicKey,
    })
  );
  const row = screen.getByText("revocations-2026").closest("[class*='items-start']") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: "Disable revocations-2026" }));
  await waitFor(() =>
    expect(trust.disableOimTrustRoot).toHaveBeenCalledWith("revocation", "revocations-2026")
  );
});

test("configures the signed feed and imports the exact signed revocation document", async () => {
  const user = userEvent.setup();
  const envelope = {
    envelopeVersion: 1,
    list: {
      sequence: 4,
      issuedAt: "2026-09-07T06:00:00.000Z",
      expiresAt: "2026-09-08T06:00:00.000Z",
      revocations: [],
    },
    signature: { algorithm: "Ed25519", keyId: "revocations-2026", value: "signed" },
  };
  render(<OimReleaseTrustPage />);

  await user.type(
    screen.getByLabelText(/^Feed URL/),
    "https://updates.example.com/oim/releases.json"
  );
  await user.click(screen.getByRole("button", { name: "Save feed" }));
  await waitFor(() =>
    expect(trust.setOimRevocationFeed).toHaveBeenCalledWith(
      "https://updates.example.com/oim/releases.json"
    )
  );
  await user.click(screen.getByRole("button", { name: "Disable automatic checks" }));
  await waitFor(() => expect(trust.disableOimRevocationFeed).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText(/^Signed revocation JSON/), {
    target: { value: JSON.stringify(envelope) },
  });
  await user.click(screen.getByRole("button", { name: "Verify and import" }));
  await waitFor(() => expect(trust.importOimRevocations).toHaveBeenCalledWith(envelope));
  expect(screen.getByText(/Accepted sequence 4/)).toBeInTheDocument();
});
