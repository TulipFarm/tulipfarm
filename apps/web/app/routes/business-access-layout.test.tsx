import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import AccessLayout from "./_app.business.access";

function renderAt(pathname: string) {
  const Stub = createRemixStub([{ path: "*", Component: AccessLayout }]);
  return render(<Stub initialEntries={[pathname]} />);
}

test.each(["/business/access/agents", "/business/access/check"])(
  "%s names the page it is a tab of",
  (pathname) => {
    renderAt(pathname);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe("People");
  }
);

test("leaves the h1 to the section shell on the tabs' own page", () => {
  renderAt("/business/access");
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
});

test("names the legacy Teams path until its redirect runs", () => {
  renderAt("/business/access/teams");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("People");
});
