import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { CROPS, type CropKind, countsFor, type FarmState, type Planting } from "~/lib/farm";
import Farm, { ErrorBoundary } from "./_app.farm";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useRouteError: vi.fn() };
});

function plant(kind: CropKind, name: string, bloomed = true, detail?: string): Planting {
  return { id: `${kind}:${name}`, kind, name, href: `/${kind}s/${name}`, bloomed, detail };
}

function farmOf(plantings: Planting[], failed: CropKind[] = []): FarmState {
  return { plantings, counts: countsFor(plantings), total: plantings.length, failed };
}

function renderFarm(farm: FarmState) {
  vi.mocked(remix.useLoaderData).mockReturnValue({ farm });
  const Stub = createRemixStub([{ path: "/farm", Component: () => <Farm /> }]);
  render(<Stub initialEntries={["/farm"]} />);
}

function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

test("names the farm by the crops it grows and points at the next empty bed", () => {
  renderFarm(farmOf([plant("skill", "a"), plant("skill", "b"), plant("agent", "c")]));

  expect(screen.getByRole("heading", { name: "Mixed beds" })).toBeInTheDocument();
  expect(screen.getByText("3 tulips")).toBeInTheDocument();
  expect(screen.getByText(/2 of 6 crops · nothing in resources yet/)).toBeInTheDocument();
});

test("counts one tulip in the singular", () => {
  renderFarm(farmOf([plant("skill", "only")]));
  expect(screen.getByText("1 tulip")).toBeInTheDocument();
});

test("stops naming an empty bed once every crop is growing", () => {
  renderFarm(farmOf(CROPS.map((crop) => plant(crop.kind, crop.kind))));

  expect(screen.getByRole("heading", { name: "Full tulip farm" })).toBeInTheDocument();
  expect(screen.getByText("All 6 crops growing")).toBeInTheDocument();
});

test("never promises progress a big single-crop farm has not made", () => {
  const many = Array.from({ length: 60 }, (_, i) => plant("skill", `s${i}`));
  renderFarm(farmOf(many));

  expect(screen.getByRole("heading", { name: "First bed" })).toBeInTheDocument();
  expect(screen.getByText("60 tulips")).toBeInTheDocument();
});

test("publishes every crop as a real link with its tally, since the canvas is aria-hidden", () => {
  renderFarm(farmOf([plant("skill", "a"), plant("skill", "b"), plant("routine", "r", false)]));

  const legend = screen.getByRole("list");
  const skills = within(legend).getByRole("link", { name: /Skills/ });
  expect(skills).toHaveAttribute("href", "/skills");
  expect(within(skills).getByText("2")).toBeInTheDocument();

  expect(within(legend).getByRole("link", { name: /Agents/ })).toHaveAttribute("href", "/agents");
  expect(within(legend).getByRole("link", { name: /Knowledge/ })).toHaveAttribute(
    "href",
    "/knowledge"
  );
});

test("summarises the field in text a screen reader can reach", () => {
  renderFarm(farmOf([plant("skill", "a"), plant("agent", "b"), plant("agent", "c")]));
  expect(screen.getByText(/3 plantings are growing: 2 agents, 1 skills/)).toBeInTheDocument();
});

test("invites the first planting instead of drawing an empty field", () => {
  renderFarm(farmOf([]));

  expect(screen.getByRole("heading", { name: "Bare soil" })).toBeInTheDocument();
  expect(screen.getByText("Nothing planted yet")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Ask in chat/ })).toHaveAttribute("href", "/");
  expect(screen.getByText("Nothing is planted yet.")).toBeInTheDocument();
});

test("says which crop is missing rather than passing a partial field off as whole", () => {
  renderFarm(farmOf([plant("skill", "a")], ["space", "integration"]));

  expect(screen.getByText(/Knowledge and Integrations could not be read/)).toBeInTheDocument();

  const legend = screen.getByRole("list");
  const knowledge = within(legend).getByRole("link", { name: /Knowledge/ });
  expect(within(knowledge).getByText("—")).toBeInTheDocument();
  expect(within(knowledge).getByText("could not be loaded")).toBeInTheDocument();
});

test("reports a total blackout through the section's error state", () => {
  renderError(<ErrorBoundary />, new ApiError(503, "api unreachable"));
  expect(screen.getByText(/error: 503/)).toBeInTheDocument();
  expect(screen.getByText("farm")).toBeInTheDocument();
});
