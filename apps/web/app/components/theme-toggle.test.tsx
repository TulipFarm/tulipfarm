import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { ThemeToggle } from "~/components/theme-toggle";

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "light");
  localStorage.clear();
});

test("toggles [data-theme] across the shell and persists it", async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);
  const button = screen.getByRole("button", { name: "Switch to dark" });

  await user.click(button);
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem("theme")).toBe("dark");

  await user.click(screen.getByRole("button", { name: "Switch to light" }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem("theme")).toBe("light");
});

/* Named for the state it moves you to: "Dark" beside a moon, in dark mode, is a riddle. */
test("names the labelled toggle for where it takes you, not where you are", async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);

  expect(screen.getByRole("button", { name: "Switch to dark" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Switch to dark" }));
  expect(screen.getByRole("button", { name: "Switch to light" })).toBeInTheDocument();
});
