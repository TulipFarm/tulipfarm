import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import DesignGuideRoute from "./_app.design-guide";

test("showcases the live token, status, action, form, and composition vocabulary", () => {
  const Stub = createRemixStub([{ path: "/design-guide", Component: DesignGuideRoute }]);
  render(<Stub initialEntries={["/design-guide"]} />);
  expect(screen.getByRole("heading", { name: "TulipFarm design guide" })).toBeInTheDocument();
  for (const heading of [
    "Design principles",
    "Tech stack",
    "Design tokens",
    "Typography scale",
    "Status & priority systems",
    "Component hierarchy",
    "Composition patterns",
    "Interactive patterns",
    "Layout system",
    "The /design-guide page",
    "Component index",
    "File conventions",
    "Common mistakes to avoid",
  ]) {
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  }
  expect(screen.getByLabelText("Name")).toBeInTheDocument();
  expect(screen.getByText("critical")).toBeInTheDocument();
}, 10_000);
