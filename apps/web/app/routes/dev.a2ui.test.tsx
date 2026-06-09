import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import DevA2ui from "~/routes/dev.a2ui";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("renders nothing outside dev (route is bundled but inert in prod)", () => {
  vi.stubEnv("DEV", false);
  const { container } = render(<DevA2ui />);
  expect(container).toBeEmptyDOMElement();
});

test("renders the harness in dev", () => {
  vi.stubEnv("DEV", true);
  const { container, getByTestId } = render(<DevA2ui />);
  expect(getByTestId("a2ui-send-in")).toBeTruthy();
  expect(container.querySelector("iframe")).toBeTruthy();
});
